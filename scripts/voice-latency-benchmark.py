"""CI-only exploratory benchmark; never run on the shared production host."""

import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import re
import resource
import statistics
import subprocess
import time
import urllib.request
import wave


ROOT = Path.cwd()
OUT = ROOT / "artifacts"
SAMPLES = ROOT / "benchmark-samples"
RUNTIME = ROOT / "native/runtime"
SAMPLE_REVISION = "3847d57b6bdf2dd8875cb1508d2af43d80a16bf7"
SAMPLE_BLOBS = {
    "zh": "1ae2c89b29112ee5e23bcebc353ea6687c38e6bd",
    "en": "325005e60db535f24f5b3d9504b209704031bdb4",
}
OUT.mkdir()
SAMPLES.mkdir()


def download(url, destination):
    with urllib.request.urlopen(url, timeout=60) as response:
        destination.write_bytes(response.read())


provenance = []
for language, blob in SAMPLE_BLOBS.items():
    url = f"https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/{SAMPLE_REVISION}/example/{language}.mp3"
    original = SAMPLES / f"{language}.mp3"
    download(url, original)
    data = original.read_bytes()
    assert hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() == blob
    subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(original), "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le", str(SAMPLES / f"{language}.wav"),
    ], check=True)
    provenance.append({"language": language, "url": url, "git_blob": blob,
                       "sha256": hashlib.sha256(data).hexdigest()})

license_url = "https://raw.githubusercontent.com/modelscope/FunASR/8d8a1a6b6e2a3946c4274243cdc6beb17855d7b5/MODEL_LICENSE"
download(license_url, OUT / "sample-source-model-license.txt")
(OUT / "provenance.json").write_text(json.dumps({
    "samples": provenance, "source": "FunAudioLLM/SenseVoiceSmall published inference examples",
    "license_url": license_url,
    "limitations": [
        "Demo probes only; no verified human reference transcripts, so no CER/WER claim.",
        "Mixed probe concatenates two speakers; not natural code-switching.",
        "30-second probe repeats the same Mandarin phrase four times, then pads silence.",
        "Short probe truncates Mandarin speech at 4 seconds; may cut a word.",
        "Warm filesystem cache, new process each trial; not disk-cold model loading.",
        "Inference timing excludes browser recording, upload, API and draft insertion.",
        "CI hardware is not production hardware; compare within-run ratios only.",
        "No private or user audio used. Source audio not included in artifacts.",
    ],
}, indent=2))


def read_audio(name):
    with wave.open(str(SAMPLES / f"{name}.wav"), "rb") as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
        return audio.readframes(audio.getnframes())


def write_audio(name, data):
    with wave.open(str(SAMPLES / f"{name}.wav"), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(data)


zh, en = read_audio("zh"), read_audio("en")
write_audio("zh-short", zh[:4 * 32000])
write_audio("mixed", zh[:12 * 32000] + bytes(16000) + en[:12 * 32000])
write_audio("mixed-en-first", en[:12 * 32000] + bytes(16000) + zh[:12 * 32000])
# Repetition is a duration/coverage probe, not natural 30-second conversation.
write_audio("zh-30", (zh + bytes(16000)) * 4 + bytes(30 * 32000 - (len(zh) + 16000) * 4))
samples = {"zh": "zh", "en": "en", "zh-short": "zh", "mixed": "zh",
           "mixed-en-first": "en", "zh-30": "zh"}
durations = {name: len(read_audio(name)) / 32000 for name in samples}
assert all(0 < duration <= 30 for duration in durations.values())
(OUT / "environment.json").write_text(json.dumps({
    "platform": platform.platform(), "cpu": Path("/proc/cpuinfo").read_text().split("\n\n")[0],
    "cpu_affinity": sorted(os.sched_getaffinity(0)), "duration_seconds": durations,
    "revision": os.environ.get("GITHUB_SHA"), "native_revision": "e4ca3a6",
    "threads": "1 except explicitly marked 2-thread experiment",
    "address_space_bytes": 1073741824, "rss_limit_kib": 393216,
    "timeout_seconds": 120, "repeats": 3,
}, indent=2))


def trial(sample, variant, repetition):
    model = "tiny" if variant.startswith("tiny") else "base"
    language = "auto" if variant.endswith("auto") else samples[sample]
    if variant == "base-force-zh":
        language = "zh"
    extra = []
    if variant == "base-short-context":
        # Experimental: 50 encoder frames per second, rounded up with padding.
        context = min(1500, math.ceil((durations[sample] + 1) / 5) * 250)
        extra = ["-ac", str(context)]
    threads = 2 if variant == "base-two-threads" else 1
    prefix = OUT / f"{sample}-{variant}-{repetition}"
    command = [
        "/usr/bin/nice", "-n", "10", "/usr/bin/prlimit", "--as=1073741824",
        "--cpu=120", "--core=0", "--", str(RUNTIME / "whisper-cli"),
        "-m", str(RUNTIME / f"ggml-{model}-q5_1.bin"), "-f", str(SAMPLES / f"{sample}.wav"),
        "-of", str(prefix), "-otxt", "-l", language, "-t", str(threads), "-p", "1",
        "-bs", "1", "-bo", "1", "-nt", "-ng", *extra,
    ]
    peak = 0
    failure = None
    cpu_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    with prefix.with_suffix(".log").open("w") as log:
        process = subprocess.Popen(command, stdout=log, stderr=log)
        while process.poll() is None:
            try:
                status = Path(f"/proc/{process.pid}/status").read_text()
            except FileNotFoundError:
                status = ""
            memory = Path("/proc/meminfo").read_text()
            match = re.search(r"^VmHWM:\s+(\d+)", status, re.M)
            if match:
                peak = max(peak, int(match[1]))
            free = re.search(r"^MemAvailable:\s+(\d+)", memory, re.M)
            if peak > 393216:
                failure = "rss_limit"
            elif not free or int(free[1]) < 262144:
                failure = "host_memory"
            elif time.monotonic() - started > 120:
                failure = "timeout"
            if failure:
                process.kill()
                break
            time.sleep(0.02)
        code = process.wait()
    elapsed = time.monotonic() - started
    cpu_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    log = prefix.with_suffix(".log").read_text()
    timings = {key: float(value) for key, value in re.findall(
        r"(load|mel|encode|decode|total) time\s*=\s*([\d.]+) ms", log)}
    encode = re.search(r"encode time.*?/\s*(\d+) runs", log)
    text_file = prefix.with_suffix(".txt")
    text = text_file.read_text().strip() if text_file.exists() else None
    return {
        "sample": sample, "variant": variant, "repeat": repetition,
        "language": language, "threads": threads,
        "audio_seconds": durations[sample], "extra_args": extra,
        "elapsed_seconds": elapsed, "cpu_seconds": cpu_after.ru_utime + cpu_after.ru_stime
        - cpu_before.ru_utime - cpu_before.ru_stime, "peak_rss_kib": peak,
        "exit_code": code, "failure": failure, "timings_ms": timings,
        "encoder_runs": int(encode[1]) if encode else None, "text": text,
    }


variants = ["base-auto", "base-language", "tiny-auto", "tiny-language",
            "base-short-context", "base-two-threads"]
jobs = [(sample, variant, repetition) for sample in samples for variant in variants
        for repetition in range(3)]
jobs += [("en", "base-force-zh", repetition) for repetition in range(3)]
random.Random(20260921).shuffle(jobs)
results = []
with (OUT / "results.jsonl").open("w") as stream:
    for sample, variant, repetition in jobs:
        result = trial(sample, variant, repetition)
        results.append(result)
        stream.write(json.dumps(result, ensure_ascii=False) + "\n")
        stream.flush()
        print(f"{sample} {variant} #{repetition}: {result['elapsed_seconds']:.2f}s"
              f" RSS={result['peak_rss_kib']} exit={result['exit_code']}", flush=True)

summary = []
for sample in samples:
    for variant in variants + (["base-force-zh"] if sample == "en" else []):
        rows = [row for row in results if row["sample"] == sample and row["variant"] == variant]
        summary.append({
            "sample": sample, "variant": variant, "audio_seconds": durations[sample],
            "median_seconds": round(statistics.median(row["elapsed_seconds"] for row in rows), 3),
            "min_seconds": round(min(row["elapsed_seconds"] for row in rows), 3),
            "max_seconds": round(max(row["elapsed_seconds"] for row in rows), 3),
            "max_rss_mib": round(max(row["peak_rss_kib"] for row in rows) / 1024, 1),
            "median_cpu_seconds": round(statistics.median(row["cpu_seconds"] for row in rows), 3),
            "encoder_runs": [row["encoder_runs"] for row in rows],
            "failures": [row["failure"] or f"exit={row['exit_code']}" for row in rows
                         if row["failure"] or row["exit_code"] or not row["text"]],
            "transcripts": sorted(set(row["text"] or "" for row in rows)),
        })
(OUT / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
assert not any(row["failure"] or row["exit_code"] for row in results), "Some runs failed; inspect results"
