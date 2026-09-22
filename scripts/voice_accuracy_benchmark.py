"""CI-only annotated model screening. Full process time includes model loading.

All three models see identical, unsegmented audio first. This isolates the
recognizer from VAD boundary effects; segmentation is a separate follow-up.
"""

import json
import os
from pathlib import Path
import platform
import re
import signal
import statistics
import subprocess
import sys
import time

from voice_accuracy_metrics import score


def command(model, sample):
    if model == "funasr-python":
        return ["/usr/bin/env", "-u", "LD_LIBRARY_PATH", sys.executable,
                "scripts/voice_funasr_python.py", f"accuracy-samples/{sample['id']}.wav"]
    args = ["sherpa/bin/sherpa-onnx-offline", "--num-threads=2",
            "--provider=cpu", "--debug=0"]
    if model == "sense":
        args += ["--tokens=model/tokens.txt", "--sense-voice-model=model/model.int8.onnx",
                 "--sense-voice-language=auto", "--sense-voice-use-itn=1"]
    elif model == "qwen":
        args += ["--qwen3-asr-conv-frontend=model/conv_frontend.onnx",
                 "--qwen3-asr-encoder=model/encoder.int8.onnx",
                 "--qwen3-asr-decoder=model/decoder.int8.onnx",
                 "--qwen3-asr-tokenizer=model/tokenizer",
                 "--qwen3-asr-max-total-len=1024", "--qwen3-asr-max-new-tokens=512",
                 "--qwen3-asr-temperature=0.000001", "--qwen3-asr-seed=42"]
    elif model in ("funasr", "funasr-ascii"):
        args += ["--funasr-nano-encoder-adaptor=model/encoder_adaptor.int8.onnx",
                 "--funasr-nano-embedding=model/embedding.int8.onnx",
                 "--funasr-nano-llm=model/llm.int8.onnx",
                 "--funasr-nano-tokenizer=model/Qwen3-0.6B",
                 "--funasr-nano-max-new-tokens=512",
                 "--funasr-nano-temperature=0.000001", "--funasr-nano-seed=42",
                 "--funasr-nano-itn=1"]
        if model == "funasr-ascii":
            args.append("--funasr-nano-user-prompt=\u8bed\u97f3\u8f6c\u5199:")
    else:
        raise ValueError(f"Unknown model: {model}")
    return args + [f"accuracy-samples/{sample['id']}.wav"]


def trial(model, sample, *, score_reference=True):
    prefix = Path("artifacts") / sample["id"]
    failure = None
    started = time.monotonic()
    with prefix.with_suffix(".log").open("w") as log, prefix.with_suffix(".stdout").open("w") as stdout:
        process = subprocess.Popen(
            ["/usr/bin/time", "-f", "%M", "-o", str(prefix.with_suffix(".rss")),
             *command(model, sample)], stdout=stdout, stderr=log, start_new_session=True)
        try:
            code = process.wait(timeout=120)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait()
            failure = "timeout_120s"
    elapsed = time.monotonic() - started
    try:
        log = prefix.with_suffix(".stdout").read_text()
    except UnicodeDecodeError:
        failure = failure or "invalid_utf8_output"
        log = ""
    text = None
    result = None
    for match in re.finditer(r"^\s*\{", log, re.M):
        try:
            candidate, _ = json.JSONDecoder().raw_decode(log[match.start():].lstrip())
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and isinstance(candidate.get("text"), str):
            result, text = candidate, candidate["text"]
    if code != 0:
        failure = failure or f"exit_{code}"
    if text is None:
        failure = failure or "missing_json_text"
    rss_file = prefix.with_suffix(".rss")
    lines = rss_file.read_text().splitlines() if rss_file.exists() else []
    rss = int(lines[-1]) if lines and lines[-1].isdigit() else None
    if rss is None:
        failure = failure or "missing_peak_memory"
    elif rss > 4 * 1024 * 1024:
        failure = failure or "rss_limit"
    if result and isinstance(result.get("tokens"), list) and len(result["tokens"]) >= 512:
        failure = failure or "possible_token_limit"
    diagnostics = prefix.with_suffix(".log").read_text(errors="replace")
    if "Truncating audio placeholders:" in diagnostics or "Falling back to keep last" in diagnostics:
        failure = failure or "context_truncation"
    return {
        **sample, "model": model, "text": text, "failure": failure,
        "exit_code": code, "seconds": elapsed, "peak_rss_kib": rss,
        "rtf": elapsed / sample["duration"],
        "score": score(sample["reference"], text) if score_reference and text is not None and not failure else None,
    }


def summarize(results):
    summary = []
    for split in ("validation", "test", "control"):
        for group in ("mixed", "mixed-word", "mixed-phrase", "zh", "en", "silence"):
            rows = [r for r in results if r["split"] == split and
                    (r["category"].startswith("mixed") if group == "mixed" else r["category"] == group)]
            if not rows:
                continue
            valid = [r for r in rows if r["score"] is not None]
            total = {key: sum(r["score"][key] for r in valid)
                     for key in ("reference_tokens", "errors", "substitutions", "deletions",
                                 "insertions", "en_tokens", "en_sd", "zh_tokens", "zh_sd",
                                 "boundary_tokens", "boundary_sd")}
            summary.append({
                "split": split, "group": group, "samples": len(rows),
                "failures": [r["id"] for r in rows if r["failure"]],
                "valid_samples": len(valid), **total,
                "mer": total["errors"] / total["reference_tokens"] if total["reference_tokens"] else None,
                "median_seconds": statistics.median(r["seconds"] for r in rows),
                "max_seconds": max(r["seconds"] for r in rows),
                "aggregate_rtf": sum(r["seconds"] for r in rows) / sum(r["duration"] for r in rows),
                "max_rss_mib": max((r["peak_rss_kib"] or 0) / 1024 for r in rows),
                "empty_speech": [r["id"] for r in rows if r["reference"] and r["text"] == ""],
                "silence_hallucinations": [r["id"] for r in rows if not r["reference"] and r["text"]],
                "scoring_note": "Failed cases excluded from MER and explicitly listed; do not compare incomplete groups.",
            })
    return summary


def main():
    from voice_accuracy_samples import prepare

    model = sys.argv[1]
    samples = prepare()
    if model == "funasr":
        diagnostics = []
        for sample in samples[:3]:
            result = trial("funasr", sample)
            diagnostics.append(result)
            # Retain both paths' logs, rather than overwriting the alternate run.
            for suffix in (".log", ".stdout", ".rss"):
                path = Path("artifacts") / (sample["id"] + suffix)
                if path.exists():
                    path.rename(path.with_name("cli-" + path.name))
        Path("artifacts/cli-diagnostic.json").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2))
        ascii_diagnostics = []
        for sample in samples[:3]:
            ascii_diagnostics.append(trial("funasr-ascii", sample))
            for suffix in (".log", ".stdout", ".rss"):
                path = Path("artifacts") / (sample["id"] + suffix)
                if path.exists():
                    path.rename(path.with_name("ascii-" + path.name))
        Path("artifacts/ascii-prompt-diagnostic.json").write_text(json.dumps(ascii_diagnostics, ensure_ascii=False, indent=2))
        model = "funasr-python"
    Path("artifacts/environment.json").write_text(json.dumps({
        "model": model, "sha": os.environ.get("GITHUB_SHA"), "platform": platform.platform(),
        "cpu": Path("/proc/cpuinfo").read_text().split("\n\n")[0],
        "threads": 2, "container_cpu_quota": 2, "container_memory_gib": 4,
        "timeout_seconds": 120, "one_fresh_process_per_sample": True,
        "timing_repeats": 1, "warm_filesystem_possible": True,
    }, indent=2))
    results = []
    with Path("artifacts/results.jsonl").open("w") as out:
        for sample in samples:
            result = trial(model, sample)
            results.append(result)
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
            out.flush()
            print(f"{sample['id']}: {result['seconds']:.2f}s failure={result['failure']}", flush=True)
            Path("artifacts/summary.json").write_text(json.dumps(summarize(results), indent=2))
            development = [r for r in results if r["split"] == "validation"]
            if len(results) == 12 and len(development) == 12 and sum(
                    r["text"] == "" or bool(r["failure"]) for r in development) >= 6:
                Path("artifacts/quality-gate-failure.txt").write_text(
                    "At least half the development speech cases returned empty text or failed. "
                    "Stopped before test evaluation; this runtime/model combination is not usable.")
                raise SystemExit("Development sanity gate failed; test set was not evaluated.")
    if any(r["failure"] for r in results):
        raise SystemExit("Inference failures; inspect artifacts. No successful fallback was substituted.")


if __name__ == "__main__":
    main()
