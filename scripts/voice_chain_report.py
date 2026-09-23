"""Select fixed chain probes and score all direct/API and browser/API attempts."""

from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil
import sys

from voice_corpus_report import VARIANTS, evaluate, summarize, validate_results
from voice_long_report import repeated_output


PIPELINES = ("direct-wav-api", "browser-recorded-api")


def select_short(rows):
    selected = []
    for category in ("zh", "en", "mixed"):
        ranked = sorted((row for row in rows if row["category"] == category),
                        key=lambda row: hashlib.sha256(f"chain-v1:{row['id']}".encode()).hexdigest())
        selected.extend(ranked[:20])
    return selected


def prepare(short, meeting, destination):
    short, meeting, destination = Path(short), Path(meeting), Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "audio").mkdir()
    manifest = []
    for source, dataset, select in ((short, "ASCEND", select_short), (meeting, "AISHELL-4", list)):
        for item in select(json.loads((source / "samples.json").read_text())):
            row = {**item, "dataset": dataset}
            audio = source / "audio" / f"{row['id']}.wav"
            if hashlib.sha256(audio.read_bytes()).hexdigest() != row["audio_sha256"]:
                raise ValueError("Input waveform checksum mismatch")
            shutil.copyfile(audio, destination / "audio" / audio.name)
            manifest.append(row)
        for name in ("ATTRIBUTION.txt", "coverage.json"):
            shutil.copyfile(source / name, destination / f"{dataset}-{name}")
    if len(manifest) != 100 or len({row["id"] for row in manifest}) != 100:
        raise ValueError("Expected 60 fixed short probes and 40 original long windows")
    (destination / "samples.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))


def combine_results(manifest, results):
    expected = {(row["id"], pipeline): row for row in manifest for pipeline in PIPELINES}
    if len(expected) != len(manifest) * len(PIPELINES):
        raise ValueError("Duplicate manifest ID")
    seen, scored = set(), []
    for result in results:
        key = result["id"], result["pipeline"]
        if key not in expected or key in seen:
            raise ValueError("Unexpected or duplicate chain result")
        seen.add(key)
        item = expected[key]
        if result["status"] == 200:
            if result["error"] is not None or not isinstance(result["text"], str):
                raise ValueError("Invalid successful API response")
            failure = None
        else:
            if not result["error"]:
                raise ValueError("Failure requires an explicit error")
            failure = result["error"]
        scored.append(evaluate({
            **item, **result, "variant": result["pipeline"], "failure": failure,
            "peak_rss_kib": result.get("peak_rss_kib"),
        }))
    if seen != expected.keys():
        raise ValueError("Incomplete pipeline coverage")
    summaries = []
    for dataset in sorted({row["dataset"] for row in manifest}):
        summaries.extend({**row, "dataset": dataset} for row in summarize(
            [row for row in scored if row["dataset"] == dataset]))
    return summaries, scored


def report(source, evidence, destination):
    source, evidence, destination = Path(source), Path(evidence), Path(destination)
    manifest = json.loads((source / "samples.json").read_text())
    results = [json.loads(line) for line in (evidence / "results.jsonl").read_text().splitlines()]
    summaries, scored = combine_results(manifest, results)
    destination.mkdir(parents=True, exist_ok=False)
    for name, data in (("summary.json", summaries), ("scored-results.json", scored)):
        (destination / name).write_text(json.dumps(data, ensure_ascii=False, indent=2))
    lines = [
        "# Voice chain acceptance: SenseVoice low-memory CI adapter", "",
        "Unchanged service: single slot/thread, 384 MiB RSS monitor, 1 GiB address space, 120s timeout.",
        "Candidate adapter replaces only the Whisper executable in isolated CI; not a production deployment.",
        "Browser: real Chromium recorder/worklet/resampler/encoder with controlled public-corpus MediaStream.",
        "Authenticated application POST is real in both conditions; chat endpoints are test fixtures.",
        "Direct input is original WAV. Browser input is rendered through 48kHz WebAudio and captured.",
        "No candidate VAD is applied: the current product has no segmentation or text-merge stage.",
        "No acoustic microphone, device noise, AEC or WebKit corpus accuracy claim.",
        "Elapsed time excludes recording/playback duration, includes upload/API/engine cold load.",
        "API rejects memory/timeout/empty outputs: failures count as complete reference deletions.", "",
        "| Dataset | Path | Group | Metric | N | Error rate | Failures | Median s | P95 s | Peak MiB |",
        "|---|---|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summaries:
        memory = f"{row['max_rss_mib']:.1f}" if row["max_rss_mib"] is not None else "unavailable"
        lines.append(f"| {row['dataset']} | {row['variant']} | {row['category']} | {row['metric']} | "
                     f"{row['samples']} | {row['error_rate']:.2%} | {row['failures']} | "
                     f"{row['median_seconds']:.2f} | {row['p95_seconds']:.2f} | {memory} |")
    pairs = {row["id"]: {} for row in manifest}
    for row in scored:
        pairs[row["id"]][row["pipeline"]] = row
    changed = Counter()
    for paths in pairs.values():
        direct, browser = (paths[key] for key in PIPELINES)
        delta = browser["delivered_score"]["errors"] - direct["delivered_score"]["errors"]
        changed["browser_worse" if delta > 0 else "browser_better" if delta < 0 else "tie"] += 1
    (destination / "paired-change.json").write_text(json.dumps(dict(changed), indent=2))
    lines += ["", f"Paired edit-count changes: {dict(changed)}",
              "Missing native peak values are explicit, not zero; a killed process may not write telemetry.",
              "100 fixed diagnostic probes, not an independent untouched holdout or acceptance threshold.",
              "Report long Mandarin and the 11 annotation-mixed meeting windows separately from ASCEND.",
              "No budget increases, reference correction or output-conditioned sample selection."]
    (destination / "REPORT.md").write_text("\n".join(lines) + "\n")
    for name in ("samples.json", "ASCEND-ATTRIBUTION.txt", "AISHELL-4-ATTRIBUTION.txt"):
        shutil.copyfile(source / name, destination / name)
    print("\n".join(lines), flush=True)


def long_report(source, evidence, destination):
    source, evidence, destination = Path(source), Path(evidence), Path(destination)
    manifest = json.loads((source / "samples.json").read_text())
    rows = [json.loads(line) for path in sorted(evidence.glob("case-*/artifacts/results.jsonl"))
            for line in path.read_text().splitlines()]
    validate_results(manifest, rows, VARIANTS)
    scored = [evaluate(row) for row in rows]
    summaries = summarize(scored)
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "summary.json").write_text(json.dumps(summaries, indent=2))
    (destination / "scored-results.json").write_text(json.dumps(scored, ensure_ascii=False, indent=2))
    flags = [{"id": row["id"], "variant": row["variant"], "failure": row["failure"],
              "repetition_candidate": repeated_output(row["text"] or ""),
              "deletions": row["delivered_score"]["deletions"]}
             for row in scored if row["failure"] or repeated_output(row["text"] or "")
             or row["delivered_score"]["deletions"]]
    (destination / "completeness-review.json").write_text(json.dumps(flags, indent=2))
    lines = [
        "# Natural long AISHELL-4 engine comparison", "",
        "40 fixed continuous 15-30s test windows: 29 Mandarin, 11 annotation-mixed.",
        "Single original channel, pauses retained; no speech splicing or overlap.",
        "CI engine-only 2 CPU/4GiB comparison, not proof of fitting the 384MiB service budget.",
        "Failure-inclusive scoring; raw output retained. No language forcing or reference hotwords.", "",
        "| Engine | Group | Metric | N | Error rate | Failures | Empty | Median s | Peak MiB |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summaries:
        memory = f"{row['max_rss_mib']:.1f}" if row["max_rss_mib"] is not None else "unavailable"
        lines.append(f"| {row['variant']} | {row['category']} | {row['metric']} | "
                     f"{row['samples']} | {row['error_rate']:.2%} | {row['failures']} | "
                     f"{row['empty_outputs']} | {row['median_seconds']:.2f} | {memory} |")
    lines += ["", "Completeness review flags include context warnings, deletions and repeated text.",
              "Deletion flags do not establish tail truncation without listening; timing-aligned reference words are unavailable.",
              "The 11 annotation-mixed samples do not establish complete English-sentence switching coverage.",
              "Far-field meetings are not personal microphone recordings. Reference quality is publisher-provided.",
              "Reference normalization and numeric handling are unchanged from the ASCEND baseline."]
    (destination / "REPORT.md").write_text("\n".join(lines) + "\n")
    for name in ("samples.json", "ATTRIBUTION.txt", "coverage.json"):
        shutil.copyfile(source / name, destination / name)
    print("\n".join(lines), flush=True)


if __name__ == "__main__":
    {"prepare": prepare, "report": report, "long": long_report}[sys.argv[1]](*sys.argv[2:])
