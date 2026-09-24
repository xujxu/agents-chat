"""Original-stimulus browser gates; same-upload baselines are diagnostic only."""

from collections import Counter
import itertools
import math
import re

from voice_choice import band, p95
from voice_corpus_report import evaluate

PLATFORMS = ("linux", "win32")
PIPELINES = ("direct", "browser")
IDENTITY = ("id", "reference", "category", "duration", "dataset", "split", "audio_sha256")


def finite(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def outcome(row):
    if row["failure"] is not None:
        if not isinstance(row["failure"], str) or not row["failure"] or row["text"] is not None:
            raise ValueError("Invalid failed delivery")
    elif not isinstance(row["text"], str) or not row["text"].strip() or "\0" in row["text"]:
        raise ValueError("Invalid successful delivery")


def validate_attempt(row):
    outcome(row)
    success = row["failure"] is None
    if row["seconds"] is not None and not finite(row["seconds"]):
        raise ValueError("Invalid attempt timing")
    if row["apiElapsedMs"] is not None and not finite(row["apiElapsedMs"]):
        raise ValueError("Invalid API timing")
    if row["status"] not in (None, 200, 422, 500, 502, 503, 504):
        raise ValueError("Unexpected HTTP status")
    if row["apiText"] is not None and (not isinstance(row["apiText"], str) or "\0" in row["apiText"]):
        raise ValueError("Invalid API text")
    if success and (row["status"] != 200 or row["text"] != row["apiText"] or row["apiElapsedMs"] is None):
        raise ValueError("Successful delivery lacks API/UI evidence")
    if row["uploadedAudioSha256"] is not None and not digest(row["uploadedAudioSha256"]):
        raise ValueError("Invalid upload hash")
    duration = row["uploadedDuration"]
    if duration is not None and (not finite(duration) or not 0 < duration <= 30):
        raise ValueError("Invalid uploaded duration")
    if (duration is None) != (row["uploadedAudioSha256"] is None):
        raise ValueError("Partial upload identity")
    if row["pipeline"] == "direct":
        if (row["uploadedAudioSha256"] != row["audio_sha256"] or duration != row["duration"]
                or row["timing"] is not None or row["capture"] is not None or row["seconds"] is None):
            raise ValueError("Direct control identity/timing differs")
        return
    timing, capture = row["timing"], row["capture"]
    if timing is not None:
        for name in ("stopAt", "workletStopAt", "fetchAt", "bodyAt", "composerAt", "terminalAt"):
            if timing.get(name) is not None and not finite(timing[name]):
                raise ValueError("Invalid browser milestone")
        if timing.get("stopAt") is not None:
            if timing.get("stopKind") not in ("manual", "automatic"):
                raise ValueError("Invalid stop origin")
            end = timing.get("composerAt") if success else timing.get("terminalAt")
            if (end is None or end < timing["stopAt"] or row["seconds"] is None
                    or abs(row["seconds"] - (end - timing["stopAt"]) / 1000) > 1e-6):
                raise ValueError("Primary interval differs from observed milestones")
        elif row["seconds"] is not None:
            raise ValueError("Latency cannot substitute for a missing stop")
    elif row["seconds"] is not None:
        raise ValueError("Browser latency lacks milestones")
    if success:
        if (timing is None or any(timing.get(k) is None for k in
                                 ("stopAt", "workletStopAt", "fetchAt", "bodyAt", "composerAt", "terminalAt"))
                or not timing["stopAt"] <= timing["workletStopAt"] <= timing["fetchAt"] <= timing["bodyAt"]
                or timing["composerAt"] < timing["fetchAt"] or timing["terminalAt"] < timing["composerAt"]
                or capture is None or capture["sourceRate"] != 48000
                or not finite(capture["recorderRate"]) or capture["recorderRate"] <= 0
                or capture["sourceCompleted"] is not True or duration is None):
            raise ValueError("Successful browser capture is incomplete")


def browser_report(samples, rows, original, baseline):
    selected = {s["id"]: s for s in samples}
    if (len(samples) != 100 or len(selected) != 100
            or Counter(s["dataset"] for s in samples) != {"ASCEND": 60, "AISHELL-4": 40}
            or any(not digest(s["audio_sha256"]) or not finite(s["duration"]) for s in samples)):
        raise ValueError("Expected frozen100 source identities")
    expected = set(itertools.product(PLATFORMS, selected, PIPELINES))
    indexed = {(r["platform"], r["id"], r["pipeline"]): r for r in rows}
    if len(indexed) != len(rows) or set(indexed) != expected:
        raise ValueError("Incomplete, duplicate or unexpected browser matrix")
    prior = {r["id"]: r for r in original}
    if len(prior) != len(original) or set(prior) != set(selected):
        raise ValueError("Original baseline coverage differs")
    for sid, row in prior.items():
        if any(row[k] != selected[sid][k] for k in IDENTITY if k != "dataset"):
            raise ValueError("Original baseline identity differs")
        outcome(row)
        if row["failure"]:
            raise ValueError("Original baseline must be successful")
    for row in rows:
        if any(row[k] != selected[row["id"]][k] for k in IDENTITY):
            raise ValueError("Attempt source identity differs")
        validate_attempt(row)
    prior_scores = {sid: evaluate(row)["delivered_score"] for sid, row in prior.items()}
    cells = []
    for platform, pipeline in itertools.product(PLATFORMS, PIPELINES):
        group = [r for r in rows if (r["platform"], r["pipeline"]) == (platform, pipeline)]
        scores = {r["id"]: evaluate(r)["delivered_score"] for r in group}
        quality, duration_metrics, violations = [], [], []
        if any(r["failure"] for r in group):
            violations.append("delivery_below_100_percent")
        for category, duration_band in sorted({(r["category"], band(r["duration"])) for r in group}):
            items = [r for r in group if (r["category"], band(r["duration"])) == (category, duration_band)]
            units = sum(scores[r["id"]]["reference_tokens"] for r in items)
            error = sum(scores[r["id"]]["errors"] for r in items) / units
            previous = sum(prior_scores[r["id"]]["errors"] for r in items) / units
            if error > previous + .02 + 1e-12:
                violations.append(f"quality:{category}/{duration_band}")
            quality.append({"category": category, "band": duration_band, "samples": len(items),
                            "error_rate": error, "baseline_error_rate": previous})
        for duration_band in ("short", "medium", "long"):
            items = [r for r in group if band(r["duration"]) == duration_band]
            if not items:
                continue
            unavailable = sum(r["seconds"] is None for r in items)
            latency = None if unavailable else p95([r["seconds"] for r in items])
            limit = {"short": 3, "long": 5}.get(duration_band)
            if unavailable:
                violations.append(f"latency_incomplete:{duration_band}")
            elif limit is not None and latency > limit:
                violations.append(f"latency:{duration_band}")
            successful = [r["seconds"] for r in items if r["failure"] is None]
            http = [(r["timing"]["bodyAt"] - r["timing"]["fetchAt"]) / 1000 for r in items
                    if r["timing"] is not None and r["timing"].get("bodyAt") is not None
                    and r["timing"].get("fetchAt") is not None]
            api = [r["apiElapsedMs"] / 1000 for r in items if r["apiElapsedMs"] is not None]
            duration_metrics.append({"band": duration_band, "samples": len(items), "unavailable": unavailable,
                                     "p95_seconds": latency, "limit_seconds": limit,
                                     "successful_p95_seconds": p95(successful) if successful else None,
                                     "http_observed": len(http), "http_p95_seconds": p95(http) if http else None,
                                     "api_observed": len(api), "api_p95_seconds": p95(api) if api else None})
        cells.append({"platform": platform, "pipeline": pipeline, "delivered": sum(not r["failure"] for r in group),
                      "eligible": not violations, "violations": violations, "quality": quality,
                      "duration": duration_metrics,
                      "failures": [{"id": r["id"], "failure": r["failure"]} for r in group if r["failure"]]})
    baseline_index = {(r["platform"], r["id"]): r for r in baseline}
    if len(baseline_index) != len(baseline) or set(baseline_index) != set(itertools.product(PLATFORMS, selected)):
        raise ValueError("Same-byte baseline coverage differs")
    comparisons = []
    for key, reference in baseline_index.items():
        row = indexed[*key, "browser"]
        outcome(reference)
        if reference["uploadedAudioSha256"] != row["uploadedAudioSha256"]:
            raise ValueError("Same-byte baseline input differs")
        if reference["unavailable"]:
            if reference["text"] is not None or reference["failure"] != "unavailable_input" or reference["seconds"] is not None:
                raise ValueError("Invalid unavailable baseline")
            available = False
        else:
            if not digest(reference["uploadedAudioSha256"]) or not finite(reference["seconds"]):
                raise ValueError("Baseline execution identity/timing differs")
            available = reference["failure"] is None and row["status"] == 200 and bool(row["apiText"])
        comparison = {"platform": key[0], "id": key[1], "available": available,
                      "input_unavailable": reference["unavailable"], "baseline_failure": reference["failure"],
                      "primary_failure": row["failure"]}
        if available:
            comparison.update(
                api_score=evaluate({**selected[key[1]], "text": row["apiText"], "failure": None})["delivered_score"],
                recorded_baseline_score=evaluate({**selected[key[1]], **reference})["delivered_score"],
                original_baseline_score=prior_scores[key[1]],
            )
        comparisons.append(comparison)
    pairs = [{"platform": platform, "id": sid,
              "both_delivered": not indexed[platform, sid, "direct"]["failure"] and not indexed[platform, sid, "browser"]["failure"],
              "equal": None if indexed[platform, sid, "direct"]["failure"] or indexed[platform, sid, "browser"]["failure"]
              else indexed[platform, sid, "direct"]["text"] == indexed[platform, sid, "browser"]["text"]}
             for platform, sid in itertools.product(PLATFORMS, selected)]
    return {"attempts": len(rows), "cells": cells, "primary_pass": all(c["eligible"] for c in cells),
            "release_approved": False, "comparison": "Original-stimulus end-to-end; not identical recognizer PCM.",
            "diagnostics": {"available": sum(c["available"] for c in comparisons),
                            "unavailable": sum(c["input_unavailable"] for c in comparisons),
                            "comparisons": comparisons, "scope": "Never overrides primary original-stimulus gates."},
            "pairs": pairs}
