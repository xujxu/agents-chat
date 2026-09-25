"""Decompose retained mixed/medium outcomes without claiming causal attribution."""

from collections import Counter
import math

from voice_accuracy_metrics import tokens
from voice_browser_cases import CASES
from voice_browser_report import IDENTITY, outcome, validate_attempt
from voice_corpus_report import evaluate

CASE = "linux-webkit-mobile"
CONTRASTS = {
    "primary": ("captured_native", "original_onnx"),
    "native_input": ("captured_native", "original_native"),
    "onnx_input": ("captured_onnx", "original_onnx"),
    "captured_backend": ("captured_native", "captured_onnx"),
}
PATHS = ("original_onnx", "original_native", "captured_onnx", "captured_native")


def index_unique(rows, fields):
    indexed = {tuple(row[field] for field in fields): row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError(f"Duplicate evidence keys: {fields}")
    return indexed


def same_rate(actual, expected):
    if not math.isfinite(expected) or not math.isclose(actual, expected, rel_tol=0, abs_tol=1e-12):
        raise ValueError("Recomputed bucket rate differs from saved report")


def analyze(samples, attempts, originals, baseline, saved):
    sources = index_unique(samples, ("id",))
    if len(sources) != 100 or Counter(s["dataset"] for s in samples) != {"ASCEND": 60, "AISHELL-4": 40}:
        raise ValueError("Expected frozen100 source identities")
    selected = sorted((s for s in samples if s["category"] == "mixed" and 5 < s["duration"] < 15),
                      key=lambda s: s["id"])
    if len(selected) != 8 or any(s["dataset"] != "ASCEND" for s in selected):
        raise ValueError("Expected eight original mixed/medium ASCEND samples")
    indexed = index_unique(attempts, ("id", "pipeline"))
    if set(indexed) != {(s["id"], p) for s in samples for p in ("direct", "browser")}:
        raise ValueError("WebKit attempts incomplete")
    for row in attempts:
        if (row.get("caseId") != CASE or row["platform"] != "linux"
                or any(row[k] != sources[row["id"],][k] for k in IDENTITY)):
            raise ValueError("WebKit attempt source/case differs")
        validate_attempt(row)
    prior = index_unique(originals, ("id",))
    references = index_unique(baseline, ("caseId", "id"))
    expected = {(case, s["id"]) for case in CASES for s in samples}
    if set(references) != expected:
        raise ValueError("Complete captured baseline matrix required")
    comparisons = index_unique(saved["diagnostics"]["comparisons"], ("caseId", "id"))
    if set(comparisons) != expected:
        raise ValueError("Saved diagnostic coverage differs")
    for key, row in references.items():
        if row["platform"] != CASES[key[0]]["platform"]:
            raise ValueError("Baseline case/host differs")
        outcome(row)
        comparison = comparisons[key]
        if (row["uploadedAudioSha256"] is None) != row["unavailable"]:
            raise ValueError("Baseline input availability differs")
        if row["failure"] != comparison["baseline_failure"] or row["unavailable"] != comparison["input_unavailable"]:
            raise ValueError("Saved baseline outcome differs")
        if key[0] == CASE and row["uploadedAudioSha256"] != indexed[key[1], "browser"]["uploadedAudioSha256"]:
            raise ValueError("Baseline upload identity differs")
    results = []
    for sample in selected:
        sid = sample["id"]
        if (sid,) not in prior:
            raise ValueError("Original baseline missing selected sample")
        original = prior[sid,]
        if any(original[k] != sample[k] for k in IDENTITY if k != "dataset"):
            raise ValueError("Original baseline source differs")
        direct, browser = indexed[sid, "direct"], indexed[sid, "browser"]
        captured = references[CASE, sid]
        comparison = comparisons[CASE, sid]
        paths = {}
        for name, row, audio_hash in (
            ("original_onnx", original, sample["audio_sha256"]),
            ("original_native", direct, direct["uploadedAudioSha256"]),
            ("captured_onnx", captured, captured["uploadedAudioSha256"]),
            ("captured_native", browser, browser["uploadedAudioSha256"]),
        ):
            outcome(row)
            scored = evaluate({**sample, "text": row["text"], "failure": row["failure"]})
            paths[name] = {
                "text": row["text"], "failure": row["failure"], "audio_sha256": audio_hash,
                "normalized_tokens": tokens(row["text"]) if row["text"] is not None else [],
                "delivered_tokens": tokens(row["text"]) if row["failure"] is None else [],
                "score": scored["delivered_score"],
            }
        if not comparison["available"]:
            raise ValueError("Selected same-upload comparison unavailable")
        api_score = evaluate({**sample, "text": browser["apiText"], "failure": None})["delivered_score"]
        if (comparison["api_score"] != api_score
                or comparison["recorded_baseline_score"] != paths["captured_onnx"]["score"]
                or comparison["original_baseline_score"] != paths["original_onnx"]["score"]):
            raise ValueError("Recomputed score differs from saved diagnostic")
        results.append({
            **sample, "caseId": CASE, "reference_tokens": tokens(sample["reference"]),
            "uploadedAudioSha256": browser["uploadedAudioSha256"],
            "uploadedDuration": browser["uploadedDuration"], "capture": browser["capture"],
            "stopKind": browser["timing"]["stopKind"] if browser["timing"] else None,
            "paths": paths,
        })
    units = sum(row["paths"]["original_onnx"]["score"]["reference_tokens"] for row in results)
    totals = {}
    for name in PATHS:
        totals[name] = {k: sum(row["paths"][name]["score"][k] for row in results)
                        for k in ("reference_tokens", "errors", "substitutions", "deletions", "insertions")}
        totals[name]["error_rate"] = totals[name]["errors"] / units
        totals[name]["delivered"] = sum(row["paths"][name]["failure"] is None for row in results)
    contrasts = {}
    for row in results:
        row["contrasts"] = {}
        for name, (left, right) in CONTRASTS.items():
            delta = row["paths"][left]["score"]["errors"] - row["paths"][right]["score"]["errors"]
            row["contrasts"][name] = {"errors": delta, "percentage_points": 100 * delta / units}
    for name, (left, right) in CONTRASTS.items():
        delta = totals[left]["errors"] - totals[right]["errors"]
        contrasts[name] = {"errors": delta, "percentage_points": 100 * delta / units}
        same_rate(sum(r["contrasts"][name]["percentage_points"] for r in results),
                  contrasts[name]["percentage_points"])
    cells = index_unique(saved["cells"], ("caseId", "pipeline"))
    if set(cells) != {(case, p) for case in CASES for p in ("direct", "browser")}:
        raise ValueError("Saved cell coverage differs")
    for pipeline, name in (("direct", "original_native"), ("browser", "captured_native")):
        groups = [g for g in cells[CASE, pipeline]["quality"] if g["category"] == "mixed" and g["band"] == "medium"]
        if len(groups) != 1 or groups[0]["samples"] != 8:
            raise ValueError("Saved selected bucket differs")
        same_rate(totals[name]["error_rate"], groups[0]["error_rate"])
        same_rate(totals["original_onnx"]["error_rate"], groups[0]["baseline_error_rate"])
    ceiling = totals["original_onnx"]["error_rate"] + .02
    return {
        "summary": {
            "caseId": CASE, "samples": 8, "reference_units": units, "totals": totals, "contrasts": contrasts,
            "quality_ceiling": ceiling,
            "primary_pass": totals["captured_native"]["delivered"] == 8
            and totals["captured_native"]["error_rate"] <= ceiling + 1e-12,
            "matches_saved": True, "release_approved": False,
            "scope": "Retained outcome decomposition, not causal acoustic attribution or new acceptance.",
        },
        "samples": results,
    }
