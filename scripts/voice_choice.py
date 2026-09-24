"""Frozen development selection and failure-inclusive candidate decision gates."""

from collections import defaultdict
import hashlib
import io
import json
import math
from pathlib import Path
import shutil
import sys
import urllib.request

from voice_corpus_data import select_rows
from voice_corpus_report import evaluate
from voice_chain_report import select_short


def p95(values):
    return sorted(values)[math.ceil(.95 * len(values)) - 1]


def band(duration):
    return "short" if duration <= 5 else "long" if duration >= 15 else "medium"


def choose_development(rows):
    if not rows or any(row["split"] != "validation" for row in rows):
        raise ValueError("Development selection requires only validation rows")
    groups = defaultdict(list)
    for row in rows:
        groups[row["variant"]].append(row)
    ids = {row["id"] for row in rows}
    for group in groups.values():
        if {row["id"] for row in group} != ids or len(group) != len(ids):
            raise ValueError("Incomplete or duplicate development configuration")
    eligible = [name for name, group in groups.items()
                if not any(row["failure"] or not row["text"] for row in group)]
    rank = lambda name: (
        sum(row["score"]["errors"] for row in groups[name]) /
        sum(row["score"]["reference_tokens"] for row in groups[name]),
        p95([row["seconds"] for row in groups[name]]), name)
    return {"variant": min(eligible, key=rank) if eligible else None,
            "development_samples": len(ids), "eligible": eligible,
            "rule": "No failed/empty dev output; lowest micro error then P95. No test data."}


def decide(rows, baseline):
    reference = {row["id"]: row for row in baseline}
    if not reference or len(reference) != len(baseline) or not rows:
        raise ValueError("Missing or duplicate evidence")
    variants = defaultdict(list)
    for row in rows:
        variants[row["variant"]].append(row)
    reports = []
    for variant, group in sorted(variants.items()):
        if len(group) != len(reference) or {row["id"] for row in group} != reference.keys():
            raise ValueError("Incomplete or duplicate test results")
        buckets = defaultdict(list)
        for row in group:
            original = reference[row["id"]]
            if any(row[key] != original[key] for key in ("reference", "category", "duration", "audio_sha256")):
                raise ValueError("Compared input identity differs")
            buckets[row["category"], band(row["duration"])].append(row)
        metrics, violations = [], []
        duration_groups = defaultdict(list)
        for row in group:
            duration_groups[band(row["duration"])].append(row)
        if any(row["failure"] or not row["text"] for row in group):
            violations.append("delivery_below_100_percent")
        for (category, duration_band), items in sorted(buckets.items()):
            units = sum(row["score"]["reference_tokens"] for row in items)
            error = sum(row["score"]["errors"] for row in items) / units
            baseline_error = sum(reference[row["id"]]["score"]["errors"] for row in items) / units
            seconds = p95([row["seconds"] for row in items])
            limit = {"short": 3, "long": 5}.get(duration_band)
            if error > baseline_error + .02 + 1e-12:
                violations.append(f"quality:{category}/{duration_band}")
            successful = [row["seconds"] for row in items if not row["failure"] and row["text"]]
            metrics.append({
                "category": category, "duration_band": duration_band, "samples": len(items),
                "error_rate": error, "baseline_error_rate": baseline_error,
                "p95_seconds": seconds, "latency_limit_seconds": limit,
                "successful_p95_seconds": p95(successful) if successful else None,
                "failures": sum(bool(row["failure"]) for row in items),
            })
        duration_metrics = []
        for duration_band, items in sorted(duration_groups.items()):
            seconds = p95([row["seconds"] for row in items])
            limit = {"short": 3, "long": 5}.get(duration_band)
            if limit is not None and seconds > limit:
                violations.append(f"latency:{duration_band}")
            duration_metrics.append({"duration_band": duration_band, "samples": len(items),
                                     "p95_seconds": seconds, "latency_limit_seconds": limit})
        mixed = [row for row in group if row["category"] == "mixed"]
        mixed_rate = (sum(row["score"]["errors"] for row in mixed) /
                      sum(row["score"]["reference_tokens"] for row in mixed)) if mixed else None
        reports.append({"variant": variant, "eligible": not violations, "violations": violations,
                        "metrics": metrics, "duration_metrics": duration_metrics, "mixed_error_rate": mixed_rate,
                        "p95_seconds": p95([row["seconds"] for row in group])})
    eligible = [row for row in reports if row["eligible"]]
    winner = None
    if eligible:
        if any(row["mixed_error_rate"] is None for row in eligible):
            raise ValueError("Missing mixed-language evidence for ranking")
        best = min(row["mixed_error_rate"] for row in eligible)
        tied = [row for row in eligible if row["mixed_error_rate"] < best + .01]
        winner = min(tied, key=lambda row: (row["p95_seconds"], row["variant"]))["variant"]
    return {"winner": winner, "candidates": reports,
            "scope": "Preliminary actual-transcriber gates only; browser/API P95 verification required before acceptance."}


def scored_rows(root, expected_variants):
    rows = []
    files = sorted(Path(root).glob("*/results.jsonl"))
    if {file.parent.name for file in files} != set(expected_variants):
        raise ValueError("Missing or unexpected candidate evidence")
    for file in files:
        completion = json.loads((file.parent / "complete.json").read_text())
        lines = file.read_text().splitlines()
        if completion["variant"] != file.parent.name or completion["count"] != len(lines):
            raise ValueError("Incomplete candidate evidence")
        for line in lines:
            row = json.loads(line)
            if row["variant"] != file.parent.name:
                raise ValueError("Candidate identity differs")
            row["score"] = evaluate(row)["delivered_score"]
            rows.append(row)
    return rows


def prepare_development(destination):
    import pyarrow.parquet as pq
    import soundfile as sf
    from voice_accuracy_samples import BASE, FILES
    destination = Path(destination)
    destination.mkdir()
    (destination / "audio").mkdir()
    cache = destination / "validation.parquet"
    urllib.request.urlretrieve(f"{BASE}/main/validation-00000-of-00001.parquet", cache)
    if hashlib.sha256(cache.read_bytes()).hexdigest() != FILES["validation"]:
        raise ValueError("Development source checksum differs")
    parquet = pq.ParquetFile(cache)
    source_rows = parquet.read(columns=["id", "duration", "transcription"]).to_pylist()
    eligible, _ = select_rows(source_rows)
    selected = []
    for category in ("zh", "en", "mixed"):
        # Include the longest original development turns without fabricating long audio.
        pool = sorted((row for row in eligible if row["category"] == category),
                      key=lambda row: (-row["duration"], row["id"]))
        selected.extend(pool[:8])
    wanted = {row["source_index"]: row for row in selected}
    offset = 0
    for batch in parquet.iter_batches(batch_size=32, columns=["audio"]):
        for index, data in enumerate(batch.to_pylist(), offset):
            if index not in wanted:
                continue
            row = wanted[index]
            row["id"] = f"validation-{row['source_id']}"
            row["split"] = "validation"
            audio, rate = sf.read(io.BytesIO(data["audio"]["bytes"]), dtype="int16")
            if rate != 16000 or audio.ndim != 1:
                raise ValueError("Invalid development audio")
            row["duration"] = len(audio) / rate
            target = destination / "audio" / f"{row['id']}.wav"
            sf.write(target, audio, rate, subtype="PCM_16")
            row["audio_sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
        offset += batch.num_rows
    if len(selected) != 24 or any("audio_sha256" not in row for row in selected):
        raise ValueError("Missing development examples")
    cache.unlink()
    (destination / "samples.json").write_text(json.dumps(selected, ensure_ascii=False, indent=2))
    (destination / "method.txt").write_text(
        "ASCEND CC-BY-SA4, Lovenia et al2022. Fixed validation partition,8 longest eligible per category.\n"
        "No test audio/output used for configuration selection. No synthetic long examples.\n")


def prepare_test(short, meeting, baseline, long_baseline, destination):
    short, meeting, destination = Path(short), Path(meeting), Path(destination)
    destination.mkdir()
    (destination / "audio").mkdir()
    manifest = []
    for source, select in ((short, select_short), (meeting, list)):
        for row in select(json.loads((source / "samples.json").read_text())):
            target = source / "audio" / f"{row['id']}.wav"
            if hashlib.sha256(target.read_bytes()).hexdigest() != row["audio_sha256"]:
                raise ValueError("Test audio checksum differs")
            shutil.copyfile(target, destination / "audio" / target.name)
            manifest.append(row)
        shutil.copyfile(source / "ATTRIBUTION.txt", destination / f"{source.name}-ATTRIBUTION.txt")
    old = [json.loads(line) for line in (Path(baseline) / "scored-results.jsonl").read_text().splitlines()]
    old += json.loads((Path(long_baseline) / "long-report/scored-results.json").read_text())
    old = {row["id"]: row for row in old if row["variant"] == "sense"}
    references = []
    for item in manifest:
        row = old[item["id"]]
        if row["failure"] or any(row[key] != item[key] for key in ("reference", "audio_sha256")):
            raise ValueError("Missing clean whole-Sense baseline")
        references.append({**item, "score": row["delivered_score"]})
    if len(manifest) != 100:
        raise ValueError("Fixed test set must contain100 original utterances")
    (destination / "samples.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    (destination / "baseline.json").write_text(json.dumps(references, ensure_ascii=False, indent=2))


def freeze(source, output):
    result = choose_development(scored_rows(source, ["segment-2", "segment-3", "segment-5"]))
    Path(output).write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    # An empty value is explicit: do not substitute a failing development candidate.
    if result["variant"]:
        print(f"SELECTED={result['variant']}", flush=True)


def report(source, test_set, output, frozen):
    selected = json.loads(Path(frozen).read_text())["variant"]
    if selected not in (None, "segment-2", "segment-3", "segment-5"):
        raise ValueError("Invalid frozen candidate")
    rows = scored_rows(source, ["whole", "whisper"] + ([selected] if selected else []))
    baseline = json.loads((Path(test_set) / "baseline.json").read_text())
    result = decide(rows, baseline)
    output = Path(output)
    output.mkdir()
    (output / "decision.json").write_text(json.dumps(result, indent=2))
    (output / "scored-results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    lines = ["# Budget-constrained model selection", "",
             "Actual transcriber guards; cold model process per request. No HTTP/browser overhead yet.",
             "Failure-inclusive rates;100%delivery,+2pp per language/duration vs identical whole-Sense references.",
             "<=5s audio:P95<=3s;15-30s:P95<=5s;medium duration reported without invented latency limit.",
             "Latency gates aggregate each duration band; language breakdowns below are diagnostic.",
             "Attempt P95 includes rejections: it is NOT successful transcription latency when failures exist.",
             "Both original corpora are already explored: not an untouched generalization holdout.", "",
             "| Candidate | Group | N | Error | Baseline | Failures | P95 s |",
             "|---|---|---:|---:|---:|---:|---:|"]
    for candidate in result["candidates"]:
        for row in candidate["metrics"]:
            lines.append(f"| {candidate['variant']} | {row['category']}/{row['duration_band']} | "
                         f"{row['samples']} | {row['error_rate']:.2%} | {row['baseline_error_rate']:.2%} | "
                         f"{row['failures']} | {row['p95_seconds']:.2f} |")
    for candidate in result["candidates"]:
        lines.append(f"\n{candidate['variant']} violations: {candidate['violations']}")
        for item in candidate["duration_metrics"]:
            lines.append(f"- {item['duration_band']}: {item['samples']} attempts, P95 {item['p95_seconds']:.2f}s.")
    lines.append(f"\nPreliminary winner: {result['winner'] or 'NONE'}. Never deploy from this report alone.")
    (output / "REPORT.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines), flush=True)


if __name__ == "__main__":
    {"dev": prepare_development, "test": prepare_test, "freeze": freeze, "report": report}[sys.argv[1]](*sys.argv[2:])
