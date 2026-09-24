"""Failure-inclusive installed API evidence using unchanged frozen-corpus gates."""

from collections import Counter
import json
import math
from pathlib import Path
import sys

from voice_choice import band, decide, p95
from voice_corpus_report import evaluate, validate_results


def installed_report(manifest, attempts, baseline):
    if len(manifest) != 100 or len({row["id"] for row in manifest}) != 100 or Counter(
            row["dataset"] for row in manifest) != {"ASCEND": 60, "AISHELL-4": 40}:
        raise ValueError("Expected exact frozen100 corpus identity")
    variants = {row["variant"] for row in attempts}
    if len(variants) != 1:
        raise ValueError("Expected one installed model")
    validate_results(manifest, attempts, variants)
    source = {row["id"]: row for row in manifest}
    prior = {row["id"]: row for row in baseline}
    if len(prior) != len(baseline):
        raise ValueError("Duplicate baseline evidence")
    reference, scored = [], []
    for row in attempts:
        sample = source[row["id"]]
        if row["dataset"] != sample["dataset"]:
            raise ValueError("Dataset identity differs")
        seconds = row["seconds"]
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds < 0:
            raise ValueError("Invalid attempt latency")
        elapsed = row.get("apiElapsedMs")
        if elapsed is not None and (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float))
                                    or not math.isfinite(elapsed) or elapsed < 0):
            raise ValueError("Invalid API processing latency")
        original = prior.get(row["id"])
        if not original or original["failure"] or not isinstance(original["text"], str) or not original["text"].strip():
            raise ValueError("Missing successful baseline")
        if any(original[key] != sample[key] for key in
               ("reference", "category", "duration", "split", "audio_sha256")):
            raise ValueError("Baseline identity differs")
        reference.append({**sample, "score": evaluate(original)["delivered_score"]})
        if row["failure"] is not None and (not isinstance(row["failure"], str) or not row["failure"]):
            raise ValueError("Invalid failure value")
        if row["text"] is not None and not isinstance(row["text"], str):
            raise ValueError("Invalid transcript type")
        checked = {**row}
        if not checked["failure"] and (not checked["text"] or not checked["text"].strip()):
            checked["failure"] = "empty_transcript"
        scored.append({**checked, "score": evaluate(checked)["delivered_score"]})
    result = decide(scored, reference)
    result.update(
        delivered=sum(not row["failure"] for row in scored), samples=len(scored),
        scope="Installed package, authenticated direct-WAV API; no browser capture timing.",
        baseline="Historical original Sense ONNX identical-input baseline used in prior engine gates.",
        release_approved=False,
        api_success_timing=[{
            "duration_band": duration_band,
            "measured_successes": len(values),
            "p95_seconds": p95(values) if values else None,
        } for duration_band in ("short", "medium", "long")
          for values in [[row["apiElapsedMs"] / 1000 for row in scored
                          if not row["failure"] and row.get("apiElapsedMs") is not None
                          and band(row["duration"]) == duration_band]]],
    )
    return result


def main(corpus, evidence, short_baseline, long_baseline, destination):
    corpus, evidence, destination = Path(corpus), Path(evidence), Path(destination)
    manifest = json.loads((corpus / "samples.json").read_text(encoding="utf-8"))
    attempts = [json.loads(line) for line in (evidence / "results.jsonl").read_text(encoding="utf-8").splitlines()]
    complete = json.loads((evidence / "complete.json").read_text(encoding="utf-8"))
    if not attempts or complete != {"count": 100, "variant": attempts[0]["variant"]}:
        raise ValueError("Incomplete collector")
    prior = [json.loads(line) for line in Path(short_baseline).read_text(encoding="utf-8").splitlines()]
    prior += json.loads(Path(long_baseline).read_text(encoding="utf-8"))
    result = installed_report(manifest, attempts, [row for row in prior if row["variant"] == "sense"])
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "summary.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    candidate = result["candidates"][0]
    lines = ["# Installed voice API acceptance", "", result["scope"], "",
             f"Delivery: {result['delivered']}/100. Gate eligible: {candidate['eligible']}.",
             f"Violations: {candidate['violations']}", "",
             "| Group | N | Error | Baseline error | Attempt P95 s |",
             "|---|---:|---:|---:|---:|"]
    for row in candidate["metrics"]:
        lines.append(f"| {row['category']}/{row['duration_band']} | {row['samples']} | "
                     f"{row['error_rate']:.2%} | {row['baseline_error_rate']:.2%} | {row['p95_seconds']:.3f} |")
    lines += ["", "Aggregate duration gates (not per-language latency gates):"]
    for row in candidate["duration_metrics"]:
        lines.append(f"- {row['duration_band']}: P95 {row['p95_seconds']:.3f}s; limit {row['latency_limit_seconds']}")
    lines += ["", "Failures count as complete reference deletions. Normalization and thresholds unchanged.",
              f"Successful API processing timing (excludes upload/auth): {result['api_success_timing']}",
              "Historical baseline is not a same-host timing comparison. Cold process, potentially warm file cache.",
              "No native peak RSS measurement; no physical microphone, browser-corpus or actual Win11 claim.",
              "No package redistribution or release approval follows from these results."]
    (destination / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0 if candidate["eligible"] else 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
