"""Analyze small CI evidence only; never load audio/models or score captions."""

from collections import Counter
import csv
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys


def nearest_rank(values, percentile):
    if not values or not 0 < percentile <= 1:
        raise ValueError("Expected nonempty values and percentile in (0, 1]")
    return sorted(values)[math.ceil(len(values) * percentile) - 1]


def inspect_log(log):
    def timing(pattern):
        matches = re.findall(pattern, log)
        return float(matches[-1]) if matches else None

    return {
        "init_seconds": timing(r"recognizer created in ([0-9.]+) s"),
        "decode_seconds": timing(r"Elapsed seconds: ([0-9.]+) s"),
        "context_truncation_warnings": [
            line for line in log.splitlines()
            if "Truncating audio placeholders:" in line or "Falling back to keep last" in line
        ],
    }


def repeated_output(text):
    normalized = re.sub(r"[\W_]+", "", text or "").lower()
    return bool(re.search(r"(.{3,80})\1{3,}", normalized))


def main():
    evidence, out = map(Path, sys.argv[1:3])
    out.mkdir(parents=True, exist_ok=True)
    summaries, flags = [], []
    baseline = None
    for variant in ("sense", "float-encoder", "safe-encoder"):
        directory = evidence / f"case-{variant}" / "artifacts"
        rows = [json.loads(line) for line in (directory / "results.jsonl").read_text().splitlines()]
        environment = json.loads((directory / "environment.json").read_text())
        if not rows or any(row["score"] is not None or row["reference"] != "" for row in rows):
            raise ValueError("Require nonempty unscored candidate evidence, never caption accuracy")
        signature = [(r["id"], r["audio_sha256"], r["duration"]) for r in rows]
        if len(set(r["id"] for r in rows)) != len(rows):
            raise ValueError("Duplicate candidate results")
        if baseline is None:
            baseline, samples = signature, rows
        elif signature != baseline:
            raise ValueError("Models did not process identical candidates")
        init, decode, truncations, empty, repetitions, failures = [], [], [], [], [], []
        for row in rows:
            diagnostic = inspect_log((directory / (row["id"] + ".log")).read_text(errors="replace"))
            if diagnostic["init_seconds"] is not None:
                init.append(diagnostic["init_seconds"])
            if diagnostic["decode_seconds"] is not None:
                decode.append(diagnostic["decode_seconds"])
            reasons = []
            if row["failure"]:
                failures.append({"id": row["id"], "failure": row["failure"]})
                reasons.append(row["failure"])
            if diagnostic["context_truncation_warnings"]:
                truncations.append(row["id"])
                reasons.append("confirmed_context_truncation")
            if row["text"] == "":
                empty.append(row["id"])
                reasons.append("empty_output_requires_listening")
            if repeated_output(row["text"]):
                repetitions.append(row["id"])
                reasons.append("repetition_requires_listening")
            if reasons:
                flags.append({"variant": variant, "id": row["id"], "duration": row["duration"],
                              "reasons": reasons, **diagnostic})
        summaries.append({
            "variant": variant, "candidates": len(rows), "environment": environment,
            "latency_scope": "full fresh process per clip, including model loading; no HTTP/upload; one repetition",
            "latency_includes_incomplete_transcriptions": True,
            "p50_seconds": statistics.median(r["seconds"] for r in rows),
            "p95_seconds_nearest_rank": nearest_rank([r["seconds"] for r in rows], .95),
            "max_seconds": max(r["seconds"] for r in rows),
            "median_init_seconds": statistics.median(init) if init else None,
            "median_decode_seconds": statistics.median(decode) if decode else None,
            "init_timings_present": len(init), "decode_timings_present": len(decode),
            "peak_rss_mib": max((r["peak_rss_kib"] or 0) / 1024 for r in rows),
            "process_failure_records": failures,
            "confirmed_context_truncation": truncations,
            "empty_output_for_review": empty, "repetitive_output_for_review": repetitions,
            "generation_stop_reason": "not exposed by pinned CLI; absence of warning does not rule out KV exhaustion",
            "verified_accuracy": None, "complete_transcription_acceptance": "NOT_ESTABLISHED",
        })
    report = {
        "evidence_run": os.environ.get("EVIDENCE_RUN"),
        "source_inference_sha": summaries[0]["environment"]["sha"],
        "analysis_sha": os.environ.get("GITHUB_SHA"),
        "selected": len(samples), "videos": len(set(r["video"] for r in samples)),
        "duration_bands": dict(Counter(
            "15-20" if r["duration"] < 20 else "20-25" if r["duration"] < 25 else "25-30"
            for r in samples)),
        "total_audio_seconds": sum(r["duration"] for r in samples),
        "models": summaries,
        "limitations": [
            "Captions only selected candidates; spoken languages and transcripts remain unverified.",
            "Zero exit codes are not proof of complete recognition; original green CI predates context-warning detection.",
            "FunASR has 512 total context slots for prompt, audio and generation, not 512 freely available output tokens.",
            "Pinned sherpa silently breaks generation at KV capacity; other short/incomplete outputs may exist.",
            "Inspect empty outputs and repetition by listening; these flags are not measured error rates.",
            "No accuracy-based model recommendation or production readiness claim.",
        ],
    }
    (out / "summary.json").write_text(json.dumps(report, indent=2))
    (out / "review-flags.json").write_text(json.dumps(flags, indent=2))
    with (out / "human-review-blind.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["id", "duration", "source_url", "archive_member", "start", "end",
                         "verified_transcript", "accept_or_reject", "natural_mixed_speech",
                         "full_english_sentence", "pause_free_switch", "notes"])
        for row in samples:
            writer.writerow([row["id"], row["duration"], row["source_url"], row["archive_member"],
                             row["start"], row["end"], "", "", "", "", "", ""])
    (out / "REVIEW-INSTRUCTIONS.txt").write_text(
        "Performance/candidate study only; not a validated accuracy benchmark.\n"
        "1. Download the public-clips artifact from the source inference run. Retain its CC-BY-3.0 attribution.\n"
        "2. Listen to the original WAV clips and fill human-review-blind.csv without first reading captions/model outputs.\n"
        "3. Reject non-mixed, unintelligible or unsuitable clips. Preserve all spoken English, repetitions and disfluencies.\n"
        "4. Have another bilingual listener independently check uncertain spans; mark uncertainty instead of guessing.\n"
        "5. Freeze references and inclusion decisions before comparing the separate model transcript CSVs.\n"
        "6. Investigate review-flags.json after independent transcription. Context warnings are runtime evidence, not accuracy scores.\n"
        "The inference CSVs and captions stay in separate artifacts to reduce reference-labeling bias.\n"
        "Run this script only in Actions. In voice-natural-long workflow, default runs analyze existing small evidence;\n"
        "explicitly enable collect_audio_and_infer to download audio and run models again.\n")
    table = ["Performance only; transcript acceptance NOT established.",
             "| Model | P50 s | P95 s | Peak MiB | Empty | Context truncation |",
             "|---|---:|---:|---:|---:|---:|"]
    for s in summaries:
        table.append(f"| {s['variant']} | {s['p50_seconds']:.2f} | {s['p95_seconds_nearest_rank']:.2f} | "
                     f"{s['peak_rss_mib']:.0f} | {len(s['empty_output_for_review'])} | "
                     f"{len(s['confirmed_context_truncation'])} |")
    print("\n".join(table))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write("\n".join(table) + "\n")


if __name__ == "__main__":
    main()
