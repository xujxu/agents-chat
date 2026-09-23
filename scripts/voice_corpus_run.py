"""Run one deterministic shard with the existing frozen CLI inference settings."""

import hashlib
import json
import os
from pathlib import Path
import platform
import sys

from voice_accuracy_benchmark import trial
from voice_corpus_report import VARIANTS


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(variant, shard, shard_count):
    if variant not in VARIANTS or not 0 <= shard < shard_count:
        raise ValueError("Invalid variant or shard")
    manifest_path = Path("../corpus/samples.json")
    manifest = json.loads(manifest_path.read_text())
    samples = sorted(manifest, key=lambda row: row["id"])[shard::shard_count]
    if not samples:
        raise ValueError("Empty corpus shard")
    output = Path("artifacts")
    output.mkdir(exist_ok=False)
    model_files = sorted(path for path in Path("model").rglob("*") if path.is_file())
    (output / "environment.json").write_text(json.dumps({
        "variant": variant, "shard": shard, "shard_count": shard_count, "samples": len(samples),
        "sha": os.environ.get("GITHUB_SHA"), "run": os.environ.get("GITHUB_RUN_ID"),
        "manifest_sha256": digest(manifest_path), "platform": platform.platform(),
        "cpu": Path("/proc/cpuinfo").read_text().split("\n\n")[0],
        "threads": 2, "cpu_quota": 2, "memory_limit_gib": 4, "timeout_seconds": 120,
        "fresh_process_per_sample": True, "timing_includes_model_load": True,
        "model_files": {str(path): digest(path) for path in model_files},
        "runtime_sha256": digest(Path("sherpa/bin/sherpa-onnx-offline")),
        "normalization": "Shared metrics; no answer prompts/hotwords or forced language",
    }, indent=2))
    count, failures = 0, 0
    with (output / "results.jsonl").open("w", encoding="utf-8") as stream:
        for sample in samples:
            audio = Path("accuracy-samples") / f"{sample['id']}.wav"
            if digest(audio) != sample["audio_sha256"]:
                raise ValueError(f"Shared audio checksum mismatch: {sample['id']}")
            result = trial("sense" if variant == "sense" else "funasr", sample, score_reference=False)
            result.update({"variant": variant, "shard": shard})
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
            stream.flush()
            count += 1
            failures += bool(result["failure"])
            print(f"{variant} shard={shard} {count}/{len(samples)}: "
                  f"{result['seconds']:.2f}s failure={result['failure']}", flush=True)
    (output / "completed.json").write_text(json.dumps({
        "variant": variant, "shard": shard, "processed": count, "expected": len(samples),
        "inference_failures": failures,
        "status": "execution_complete_with_failures" if failures else "execution_complete",
        "note": "Completion means accounted-for attempts, not accuracy or deployment acceptance.",
    }, indent=2))
    if failures:
        print(f"::warning::{variant} shard {shard}: {failures} inference failures; retained for failure-inclusive scoring")


if __name__ == "__main__":
    run(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
