"""Actions-only report; acoustic findings never replace product acceptance."""

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path

import numpy as np

from voice_graph_evidence import PROJECTS, STIMULI, expected_ids, load_attempt, rows_from, unique_attempts
from voice_graph_metrics import METHOD, describe, envelope, quantize

FILES = [
    "tests/helpers/voiceGraphStimuli.ts", "tests/helpers/voiceGraphProbe.ts",
    "tests/helpers/voiceGraphCollector.ts", "tests/helpers/voiceBrowserCapture.ts",
    "tests/voice-audio-graph.spec.ts", "tests/playwright.voice-graph.config.ts",
    "app/features/composer/voice/voiceRecorder.ts", "public/voice/recorder-worklet.js",
    "lib/voice/audio.ts", "scripts/voice_graph_metrics.py", "scripts/voice_graph_evidence.py",
    "scripts/voice_graph_report.py",
]


def difference(a, b):
    same_length = len(a) == len(b)
    length = min(len(a), len(b))
    indices = np.flatnonzero(a[:length] != b[:length])
    return {"equal": same_length and not len(indices), "left_samples": len(a), "right_samples": len(b),
            "differing_samples": int(len(indices)) + abs(len(a) - len(b)),
            "first_different": int(indices[0]) if len(indices) else (length if not same_length else None)}


def analyze(root, row):
    fingerprints = {file: hashlib.sha256(Path(file).read_bytes()).hexdigest() for file in FILES}
    if row["environment"]["implementation"] != fingerprints:
        raise ValueError("Implementation fingerprint mismatch")
    stages, pcm = load_attempt(root, row)
    source = envelope(stages["A"][1][0], stages["A"][0])
    templates = [source[start:start+200] for start in METHOD["marker_starts_ms"]]
    metrics = {name: [describe(channel, rate, row["stimulus"], templates, name in ("A", "F"))
                      for channel in channels] for name, (rate, channels) in stages.items()}
    checks = {}
    if row["mode"] == "full":
        c, d, e = (stages[name][1][0] for name in "CDE")
        checks = {"C_D": difference(c, d), "E_F": difference(quantize(e), pcm),
                  "render_length": {"actual": len(e),
                                    "expected": min(480000, int(np.ceil(len(d) * 16000 / stages["D"][0]))) }}
        checks["render_length"]["equal"] = checks["render_length"]["actual"] == checks["render_length"]["expected"]
        if row["stimulus"] == "stereo-tones":
            metrics["B_arithmetic_mean_prediction"] = [describe(
                np.mean(stages["B"][1], axis=0), stages["B"][0], row["stimulus"], templates)]
    return {"id": row["id"], "status": "complete", "metrics": metrics, "checks": checks,
            "snapshot": row["snapshot"], "probe": row["probe"],
            "source_sha256": row["A"]["sha256"], "upload_sha256": row["F"]["sha256"],
            "environment": row["environment"]}


def paired(minimal, full):
    a, b = minimal["metrics"]["F"][0], full["metrics"]["F"][0]
    result = {"minimal": minimal["id"], "full": full["id"], "direction": "full_minus_minimal",
              "statistics": {key: b["stats"][key] - a["stats"][key]
                             for key in ("samples", "duration_seconds", "rms", "peak", "dc")}}
    if "tones" in a:
        result["amplitudes"] = {key: b["tones"]["amplitudes"][key] - value
                                for key, value in a["tones"]["amplitudes"].items()}
    else:
        result["marker_positions_ms"] = [
            {"difference": y["position_ms"] - x["position_ms"], "reason": None}
            if x["reliable"] and y["reliable"] else
            {"difference": None, "reason": "unreliable_marker"}
            for x, y in zip(a["markers"], b["markers"])]
        result["interval_differences_ms"] = [
            {"difference": y["delta_ms"] - x["delta_ms"], "reason": None}
            if x["reason"] is None and y["reason"] is None else
            {"difference": None, "reason": "unreliable_marker"}
            for x, y in zip(a["intervals"], b["intervals"])]
    result["timings"] = {}
    for label, first, last in (("stop_to_upload_ms", "stopAt", "fetchAt"),
                                ("stop_to_composer_ms", "stopAt", "composerAt")):
        times = []
        for item in (minimal, full):
            timing = item["snapshot"]["timing"]
            if timing[first] is None or timing[last] is None:
                raise ValueError("Missing same-clock milestone")
            times.append(timing[last] - timing[first])
        result["timings"][label] = {"minimal": times[0], "full": times[1], "difference": times[1] - times[0]}
    return result


def run(root, output, contracts=False):
    output.mkdir(parents=True, exist_ok=True)
    rows = rows_from(root)
    failures, results, pairs = [], [], []
    try:
        if contracts:
            wanted = {f"{project}/mono-tones/0/full" for project in PROJECTS}
            if len(rows) != 2 or {row["id"] for row in rows} != wanted:
                raise ValueError("Incomplete browser contract evidence")
        else:
            unique_attempts(rows)
    except (ValueError, KeyError) as error:
        failures.append(str(error))
    sources = {}
    for row in rows:
        try:
            result = analyze(root, row)
            previous = sources.setdefault(row["stimulus"], result["source_sha256"])
            if previous != result["source_sha256"]:
                raise ValueError("Changed stimulus across attempts")
            results.append(result)
            if contracts and any(not check["equal"] for check in result["checks"].values()):
                failures.append(f'{row["id"]}: exact boundary contract failed')
        except (ValueError, KeyError, TypeError, OSError) as error:
            failures.append(f'{row.get("id", "unknown")}: {error}')
            results.append({"id": row.get("id"), "status": "evidence_failure", "error": str(error)})
    if not contracts:
        indexed = {result["id"]: result for result in results if result["status"] == "complete"}
        for project in PROJECTS:
            for stimulus in STIMULI:
                for repeat in range(3):
                    prefix = f"{project}/{stimulus}/{repeat}"
                    if all(f"{prefix}/{mode}" in indexed for mode in ("minimal", "full")):
                        try:
                            pairs.append(paired(indexed[f"{prefix}/minimal"], indexed[f"{prefix}/full"]))
                        except ValueError as error:
                            failures.append(f"{prefix}: {error}")
    findings = [{"id": result["id"], "checks": result["checks"]}
                for result in results if result["status"] == "complete"
                and any(not check["equal"] for check in result["checks"].values())]
    summary = {"status": "evidence_failure" if failures else "complete",
               "run": os.environ["GITHUB_RUN_ID"], "commit": os.environ["GITHUB_SHA"],
               "method": METHOD, "python": platform.python_version(), "numpy": np.__version__,
               "expected": 2 if contracts else 36, "observed": len(rows),
               "completed": sum(result["status"] == "complete" for result in results),
               "pairs": len(pairs), "failures": failures, "exact_boundary_findings": findings,
               "planned_ids": sorted({row["id"] for row in rows}) if contracts else expected_ids(),
               "limits": ["Synthetic no-ASR fixture, not product qualification",
                          "Linux iPhone emulation is not real Safari/iPhone",
                          "Incremental observer comparisons do not prove non-interference",
                          "B-C cannot distinguish stream conversion from channel mixing"]}
    for name, value in (("summary.json", summary), ("attempts.json", results), ("pairs.json", pairs)):
        (output / name).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    lines = ["# Controlled audio graph probe", "", f"Status: {summary['status']}",
             f"Complete: {summary['completed']}/{summary['expected']}; pairs: {len(pairs)}", "",
             "| Attempt | Evidence | C-D | E-F |", "| --- | --- | --- | --- |"]
    for result in results:
        checks = result.get("checks", {})
        lines.append(f"| {result['id']} | {result['status']} | "
                     f"{checks.get('C_D', {}).get('equal', 'not collected')} | "
                     f"{checks.get('E_F', {}).get('equal', 'not collected')} |")
    lines += ["", "## Failures", *failures, "", "## Limits", *summary["limits"],
              "", "All stage measurements and reliability flags: attempts.json.",
              "All signed incremental-observer comparisons: pairs.json.",
              "No historical quality or latency gate is replaced by this report."]
    (output / "REPORT.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"status": summary["status"], "complete": summary["completed"], "failures": failures}))
    return 1 if failures else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--contracts", action="store_true")
    arguments = parser.parse_args()
    raise SystemExit(run(arguments.input, arguments.output, arguments.contracts))
