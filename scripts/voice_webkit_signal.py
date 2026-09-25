"""Actions-only inspection of eight original and retained WebKit PCM pairs."""

import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import zipfile

import numpy as np

from voice_browser_evidence import load_platform
from voice_browser_report import IDENTITY
from voice_consistency_report import read_json
from voice_feature_data import read_bounded, sha, validate_wav
from voice_signal_metrics import METHOD, RATE, compare_signals
from voice_webkit_analysis import CASE, index_unique
from voice_webkit_evidence import SOURCE_COMMIT, SOURCE_RUN, download

IDS = ("test-00332", "test-00364", "test-00554", "test-00949",
       "test-01049", "test-01050", "test-01056", "test-01058")
DECOMPOSITION_RUN = "36090984994"
DECOMPOSITION_COMMIT = "965574245761448173414b83ef454f4042442b5a"
INPUTS = {
    "source": ("10748244312", "35858271102", "ascend-test-corpus",
               "8f81879b98c3a64c557a9c7772fbb5b988b408018e6313800c96efb3ebc5fda0"),
    "webkit": ("10844047138", SOURCE_RUN, "installed-browser-linux-webkit-mobile",
               "0d2db5c932f787681047f425f984156c3c327e1428078eef0b1c42cf5fa6b9ff"),
    "decomposition": ("10845901259", DECOMPOSITION_RUN, "webkit-error-analysis",
                      "52e23b1399a98828f7a409a713a6009cc1f9f8022f69cdc1f5541d5214a475de"),
}
COMMITS = {"source": "1f773d5996f5d684ce1570705b6bb2344beee264",
           "webkit": SOURCE_COMMIT, "decomposition": DECOMPOSITION_COMMIT}


def pcm(path, expected_hash, duration):
    raw = read_bounded(path, 960044)
    if sha(raw) != expected_hash:
        raise ValueError("Selected waveform checksum differs")
    count = validate_wav(raw)
    if not math.isclose(count / RATE, duration, rel_tol=0, abs_tol=1e-9):
        raise ValueError("Selected waveform duration differs")
    return np.frombuffer(raw, dtype="<i2", offset=44)


def load_pairs(inputs):
    inputs = Path(inputs)
    samples, attempts, _ = load_platform(inputs / "webkit", "linux", SOURCE_RUN, SOURCE_COMMIT, CASE)
    selected = sorted((s for s in samples if s["category"] == "mixed" and 5 < s["duration"] < 15),
                      key=lambda s: s["id"])
    if tuple(s["id"] for s in selected) != IDS or any(s["dataset"] != "ASCEND" for s in selected):
        raise ValueError("Fixed eight-sample selection differs")
    original = index_unique(read_json(inputs / "source/samples.json"), ("id",))
    previous = index_unique(read_json(inputs / "decomposition/samples.json"), ("id",))
    if set(previous) != {(sid,) for sid in IDS}:
        raise ValueError("Decomposition selection differs")
    summary = read_json(inputs / "decomposition/summary.json")
    if (summary.get("source") != {"run": SOURCE_RUN, "commit": SOURCE_COMMIT}
            or summary.get("analysis") != {"run": DECOMPOSITION_RUN, "commit": DECOMPOSITION_COMMIT}
            or summary.get("status") != "complete" or summary.get("matches_saved") is not True
            or summary.get("caseId") != CASE or summary.get("samples") != 8):
        raise ValueError("Historical decomposition identity differs")
    indexed = index_unique(attempts, ("id", "pipeline"))
    for sample in selected:
        sid = sample["id"]
        if (sid,) not in original:
            raise ValueError("Original source missing selected sample")
        before, comparison = original[sid,], previous[sid,]
        if (any(before[k] != sample[k] for k in IDENTITY if k != "dataset")
                or any(comparison[k] != sample[k] for k in IDENTITY) or comparison.get("caseId") != CASE):
            raise ValueError("Historical source/decomposition identity differs")
        browser = indexed[sid, "browser"]
        if (comparison["uploadedAudioSha256"] != browser["uploadedAudioSha256"]
                or comparison["uploadedDuration"] != browser["uploadedDuration"]):
            raise ValueError("Historical upload/decomposition identity differs")
        source_pcm = pcm(inputs / "source/audio" / f"{sid}.wav", sample["audio_sha256"], sample["duration"])
        upload_pcm = pcm(inputs / "webkit/captured" / f"{sid}.wav",
                         browser["uploadedAudioSha256"], browser["uploadedDuration"])
        yield {
            "id": sid, "source_sha256": sample["audio_sha256"], "upload_sha256": browser["uploadedAudioSha256"],
            "primary_error_contribution": comparison["contrasts"]["primary"],
            "capture": browser["capture"], "stopKind": browser["timing"]["stopKind"],
        }, source_pcm, upload_pcm


def write_report(output, summary, samples):
    output.mkdir(parents=True, exist_ok=True)
    for name, value in (("summary", summary), ("samples", samples)):
        (output / f"{name}.json").write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    lines = ["# Retained WebKit waveform diagnostics", "",
             "Eight fixed source/upload pairs. No capture, inference, resampling or corrected audio.", "",
             "| Sample | Error delta | Duration delta s | Lag samples | Correlation | Peak gap | Relative residual | Flags |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |"]
    for sample in samples:
        global_result = sample["global"]
        lines.append(f"| {sample['id']} | {sample['primary_error_contribution']['errors']:+d} | "
                     f"{sample['duration_delta_seconds']:.6f} | {global_result['lag_samples']} | "
                     f"{global_result['correlation']} | {global_result['peak_gap']} | "
                     f"{global_result['relative_residual_rms']} | {', '.join(global_result['flags']) or 'none'} |")
    lines += ["", "| Sample | Original RMS dBFS | Upload RMS dBFS | Centered gain | Local lags (samples) | Last minus first |",
              "| --- | ---: | ---: | ---: | --- | ---: |"]
    for sample in samples:
        lines.append(f"| {sample['id']} | {sample['original']['rms_dbfs']} | {sample['uploaded']['rms_dbfs']} | "
                     f"{sample['global']['centered_gain']} | "
                     f"{[w['lag_samples'] for w in sample['windows']]} | {sample['last_minus_first_samples']} |")
    lines += ["", "See samples.json for full-signal level/rail/frame intervals, overlap coverage, unmatched regions,",
              "local correlations/flags and explicit uncertainty. Positive lag means uploaded content is later.",
              "Low-energy intervals are descriptive, not speech detection; rail hits alone do not establish clipping.",
              "Residuals use unscaled original amplitudes; no optimized audio is written or submitted to inference.",
              "Weak/ambiguous/boundary matching cannot establish a reliable offset or a causal defect.",
              "No browser, resampler, lost-speech or clock-drift root cause follows from these metrics alone.",
              "The prior failed acceptance result is unchanged. ASCEND attribution is retained alongside the report."]
    (output / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines), flush=True)


def run(inputs, output):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Signal computation requires Actions")
    inputs, output = Path(inputs), Path(output)
    artifacts = download(inputs, INPUTS, COMMITS)
    samples = []
    for metadata, source_pcm, upload_pcm in load_pairs(inputs):
        samples.append({**metadata, **compare_signals(source_pcm, upload_pcm)})
    if tuple(s["id"] for s in samples) != IDS:
        raise ValueError("Incomplete signal pair analysis")
    summary = {
        "status": "complete", "samples": 8, "caseId": CASE, "release_approved": False,
        "method": METHOD, "versions": {"numpy": np.__version__, "python": platform.python_version()},
        "source": {"run": SOURCE_RUN, "commit": SOURCE_COMMIT},
        "decomposition": {"run": DECOMPOSITION_RUN, "commit": DECOMPOSITION_COMMIT},
        "analysis": {"run": os.environ["GITHUB_RUN_ID"], "commit": os.environ["GITHUB_SHA"]},
        "artifacts": artifacts, "reliable_global_matches": sum(s["global"]["reliable"] for s in samples),
        "reliable_segment_comparisons": sum(s["last_minus_first_samples"] is not None for s in samples),
        "scope": "Retained waveform diagnostics, not causal attribution or altered acceptance.",
    }
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(inputs / "source/ATTRIBUTION.txt", output / "ASCEND-ATTRIBUTION.txt")
    write_report(output, summary, samples)


def main(args):
    if len(args) != 2:
        raise ValueError("Expected input and output directories")
    try:
        run(*args)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        output = Path(args[1])
        output.mkdir(parents=True, exist_ok=True)
        failure = {"status": "incomplete", "release_approved": False, "error": str(error)}
        (output / "failure.json").write_text(json.dumps(failure, indent=2), encoding="utf-8")
        print(json.dumps(failure), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
