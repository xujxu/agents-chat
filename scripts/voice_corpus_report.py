"""Comparable corpus metrics with explicit execution failures and coverage."""

from collections import Counter
import csv
import json
from pathlib import Path
import statistics

from voice_accuracy_metrics import score_units, tokens


VARIANTS = ("sense", "safe-encoder")


def evaluate(row):
    category = row["category"]
    if category not in ("zh", "en", "mixed"):
        raise ValueError(f"Unknown category: {category}")

    def units(text):
        normalized = tokens(text)
        return list("".join(normalized)) if category == "zh" else normalized

    reference = units(row["reference"])
    if not reference:
        raise ValueError("Cannot score empty reference")
    raw = score_units(reference, units(row["text"])) if isinstance(row["text"], str) else None
    if row["failure"] is None and raw is None:
        raise ValueError("Successful inference must contain text")
    delivered = score_units(reference, []) if row["failure"] else raw
    return {
        **row, "metric": {"zh": "CER", "en": "WER", "mixed": "MER"}[category],
        "raw_score": raw, "delivered_score": delivered,
        "successful_score": raw if not row["failure"] else None,
    }


def summarize(rows):
    summaries = []
    for variant, category in sorted({(row["variant"], row["category"]) for row in rows}):
        group = [row for row in rows if (row["variant"], row["category"]) == (variant, category)]
        successful = [row for row in group if row["successful_score"] is not None]
        units = sum(row["delivered_score"]["reference_tokens"] for row in group)
        errors = sum(row["delivered_score"]["errors"] for row in group)
        success_units = sum(row["successful_score"]["reference_tokens"] for row in successful)
        memory = [row["peak_rss_kib"] for row in group if row["peak_rss_kib"] is not None]
        summaries.append({
            "variant": variant, "category": category, "metric": group[0]["metric"],
            "samples": len(group), "reference_units": units, "errors": errors,
            "error_rate": errors / units, "successful_samples": len(successful),
            "successful_error_rate": sum(row["successful_score"]["errors"] for row in successful)
            / success_units if success_units else None,
            "substitutions": sum(row["delivered_score"]["substitutions"] for row in group),
            "deletions": sum(row["delivered_score"]["deletions"] for row in group),
            "insertions": sum(row["delivered_score"]["insertions"] for row in group),
            "failures": sum(bool(row["failure"]) for row in group),
            "failure_reasons": dict(Counter(row["failure"] for row in group if row["failure"])),
            "empty_outputs": sum(row["text"] == "" for row in group),
            "median_seconds": statistics.median(row["seconds"] for row in group),
            "p95_seconds": sorted(row["seconds"] for row in group)[(95 * len(group) + 99) // 100 - 1],
            "aggregate_rtf": sum(row["seconds"] for row in group) / sum(row["duration"] for row in group),
            "max_rss_mib": max(memory) / 1024 if memory else None,
            "missing_rss_samples": len(group) - len(memory),
        })
    return summaries


def validate_results(manifest, rows, variants):
    expected = {(variant, row["id"]): row for variant in variants for row in manifest}
    if len(expected) != len(manifest) * len(variants):
        raise ValueError("Duplicate manifest identifiers or variants")
    seen = set()
    for row in rows:
        key = row["variant"], row["id"]
        if key not in expected or key in seen:
            raise ValueError(f"Unexpected or duplicate result: {key}")
        if any(row[field] != expected[key][field]
               for field in ("reference", "category", "split", "duration", "audio_sha256")):
            raise ValueError(f"Result/manifest identity mismatch: {key}")
        seen.add(key)
    if seen != expected.keys():
        raise ValueError(f"Incomplete corpus execution: {len(seen)}/{len(expected)} results")


def report(source, evidence, destination):
    source, evidence, destination = Path(source), Path(evidence), Path(destination)
    manifest = json.loads((source / "samples.json").read_text())
    rows = [json.loads(line) for path in sorted(evidence.glob("**/results.jsonl"))
            for line in path.read_text().splitlines()]
    validate_results(manifest, rows, VARIANTS)
    scored = [evaluate(row) for row in rows]
    summaries = summarize(scored)
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "summary.json").write_text(json.dumps(summaries, indent=2) + "\n")
    with (destination / "scored-results.jsonl").open("w", encoding="utf-8") as stream:
        for row in scored:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    fields = ["variant", "id", "category", "metric", "duration", "reference", "text",
              "failure", "seconds", "peak_rss_kib"]
    with (destination / "comparison.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(scored)
    lines = [
        "# ASCEND test engine baseline",
        "",
        "Two engines: SenseVoice INT8 and FunASR-Nano with U8U8 encoder/LLM, release INT8 embedding.",
        "Full eligible test split; shared audio and fixed decoding. Not a full product/API benchmark.",
        "Failed executions count as empty delivered output (all reference units deleted).",
        "Successful-only rates are conditional diagnostics and not comparable when coverage differs.",
        "",
        "| Engine | Group | Metric | N | Error rate | Failures | Empty | Median s | P95 s |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summaries:
        lines.append(
            f"| {row['variant']} | {row['category']} | {row['metric']} | {row['samples']} | "
            f"{row['error_rate']:.2%} | {row['failures']} | {row['empty_outputs']} | "
            f"{row['median_seconds']:.2f} | {row['p95_seconds']:.2f} |")
    lines += [
        "", "## Method and limitations", "",
        "- Corpus-micro edit rates, not an average of per-clip rates; rates can exceed 100%.",
        "- Chinese: character units; English: word units; mixed: Han characters plus English words.",
        "- NFKC, simplified Chinese, lowercase, ignored punctuation; numbers not semantically rewritten.",
        "- Failure scoring is a declared no-delivery policy, not a measurement of hidden partial output.",
        "- Original and normalized reference/output scores retained for error review.",
        "- Previous exploratory subsets used this test split; this is not a newly untouched holdout.",
        "- Model pretraining overlap unknown. Corpus transcripts are not guaranteed error-free.",
        "- Short conversational turns do not establish natural 15-30s performance or microphone accuracy.",
        "- Fresh process per clip; timings include model load and possible warm filesystem caches.",
        "- Engines share each shard's runner, but shards may use different CPUs; no deployment latency claim.",
        "- CI limits are 2 CPU / 4 GiB per engine; this does not prove suitability for the PROD budget.",
        "- CC-BY-SA-4.0 ASCEND references; see accompanying dataset card and attribution.",
    ]
    (destination / "REPORT.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:15]), flush=True)


if __name__ == "__main__":
    import sys
    report(*sys.argv[1:])
