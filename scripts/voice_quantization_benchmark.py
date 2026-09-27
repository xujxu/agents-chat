"""Compare quantization ablations on identical audio, tokenizer and CPU."""

import json
import os
from pathlib import Path
import platform
import sys

from voice_accuracy_benchmark import summarize, trial


variant = sys.argv[1]
samples = json.loads(Path("../artifacts/samples.json").read_text())
cpu = Path("/proc/cpuinfo").read_text().split("\n\n")[0]
Path("artifacts/environment.json").write_text(json.dumps({
    "variant": variant, "cpu": cpu, "platform": platform.platform(),
    "revision": os.environ.get("GITHUB_SHA"),
    "avx512_vnni": "avx512_vnni" in cpu, "avx_vnni": " avx_vnni " in cpu,
    "threads": 2, "memory_limit_gib": 4, "timeout_seconds": 120,
    "audio_encoder": {"float-encoder": "FP32", "safe-encoder": "U8U8"}.get(variant, "release INT8"),
    "embedding": "unchanged release INT8",
    "model_loading": "new process per sample; possible warm filesystem cache",
}, indent=2))
results = []
with Path("artifacts/results.jsonl").open("w") as stream:
    for sample in samples:
        result = trial("funasr", sample)
        result["variant"] = variant
        results.append(result)
        stream.write(json.dumps(result, ensure_ascii=False) + "\n")
        stream.flush()
        Path("artifacts/summary.json").write_text(json.dumps(summarize(results), indent=2))
        print(f"{variant} {sample['id']}: {result['seconds']:.2f}s {result['failure']}", flush=True)
        if len(results) == 12:
            dev = next(r for r in summarize(results) if r["group"] == "mixed")
            if sum(r["text"] == "" or bool(r["failure"]) for r in results) >= 6 or (
                    dev["mer"] is not None and dev["mer"] >= 0.8):
                Path("artifacts/quality-gate-failure.txt").write_text(
                    "Development gate: at least half empty/failed or MER >= 80%; not evaluated on test.")
                raise SystemExit("Development quality gate failed")
if any(r["failure"] for r in results):
    raise SystemExit("Inference failures; inspect evidence")
Path("artifacts/completed.json").write_text(json.dumps({
    "variant": variant, "samples": len(results), "execution_failures": 0,
    "note": "Execution completion only; accuracy is reported separately in summary.json.",
}))
