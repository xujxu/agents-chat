"""Performance only: unverified captions must never become scoring references."""

import csv
import json
import os
from pathlib import Path
import platform
import statistics
import sys

from voice_accuracy_benchmark import trial


def main():
    variant = sys.argv[1]
    if variant not in ("sense", "float-encoder", "safe-encoder"):
        raise ValueError(f"Unexpected variant: {variant}")
    samples = json.loads(Path("accuracy-samples/samples.json").read_text())
    out = Path("artifacts")
    out.mkdir(exist_ok=True)
    (out / "environment.json").write_text(json.dumps({
        "variant": variant, "sha": os.environ.get("GITHUB_SHA"), "platform": platform.platform(),
        "cpu": Path("/proc/cpuinfo").read_text().split("\n\n")[0],
        "threads": 2, "cpu_quota": 2, "memory_limit_gib": 4, "per_sample_timeout_seconds": 120,
        "repetitions": 1, "includes_model_load": True, "filesystem_cache_may_be_warm": True,
        "scoring": "disabled; captions are unverified, no accuracy conclusions",
    }, indent=2))
    results = []
    with (out / "results.jsonl").open("w") as stream:
        for sample in samples:
            if sample["reference"] != "" or sample["review_status"] != "pending":
                raise ValueError("Expected only unverified caption candidates without scoring references")
            result = trial("sense" if variant == "sense" else "funasr", sample, score_reference=False)
            result["variant"] = variant
            assert result["score"] is None, "Unverified captions must not be scored"
            results.append(result)
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
            stream.flush()
            print(f"{variant} {sample['id']}: {result['seconds']:.2f}s failure={result['failure']}", flush=True)
            summary = {
                "variant": variant, "total_candidates": len(samples), "processed": len(results),
                "failures": [{"id": r["id"], "reason": r["failure"]} for r in results if r["failure"]],
                "median_seconds": statistics.median(r["seconds"] for r in results),
                "max_seconds": max(r["seconds"] for r in results),
                "aggregate_rtf": sum(r["seconds"] for r in results) / sum(r["duration"] for r in results),
                "max_rss_mib": max((r["peak_rss_kib"] or 0) / 1024 for r in results),
                "empty_outputs_for_review": [r["id"] for r in results if r["text"] == ""],
                "accuracy": None, "caption_agreement_score": None,
                "limitations": "Performance only. Empty/nonempty output is not proof of missed/correct speech. No verified references.",
            }
            (out / "summary.json").write_text(json.dumps(summary, indent=2))
    with (out / "transcripts-for-review.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["id", "duration", "caption_UNVERIFIED", "model_transcript", "failure"])
        for result in results:
            writer.writerow([result["id"], result["duration"], result["caption"], result["text"], result["failure"]])
    if any(result["failure"] for result in results):
        raise SystemExit("Some candidates failed: see explicit failure list; do not report full success")


if __name__ == "__main__":
    main()
