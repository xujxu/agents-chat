"""Paired diagnostics, not automatic claims about the cause of human ASR errors."""

from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import re
import shutil
import unicodedata

from voice_accuracy_metrics import TOKEN, score_units
from voice_corpus_report import VARIANTS, evaluate
from voice_long_report import repeated_output


def audit_pairs(rows):
    by_id = {}
    for row in rows:
        if row["variant"] not in VARIANTS or row["variant"] in by_id.setdefault(row["id"], {}):
            raise ValueError("Unknown or duplicate model result")
        by_id[row["id"]][row["variant"]] = row
    pairs, wins, flags_count = [], Counter(), Counter()
    normalization = Counter({variant: 0 for variant in VARIANTS})
    for identifier, models in sorted(by_id.items()):
        if set(models) != set(VARIANTS):
            raise ValueError("Missing paired result")
        left, right = (models[variant] for variant in VARIANTS)
        if any(left[field] != right[field] for field in ("reference", "category")):
            raise ValueError("Paired source identity differs")
        scores = {variant: evaluate(row) for variant, row in models.items()}
        errors = {variant: row["delivered_score"]["errors"] for variant, row in scores.items()}
        winner = "tie" if len(set(errors.values())) == 1 else min(errors, key=errors.get)
        wins[winner] += 1
        flags = []
        if any(row["delivered_score"]["en_sd"] for row in scores.values()):
            flags.append("english_span_error")
        if any(row["delivered_score"]["boundary_sd"] for row in scores.values()):
            flags.append("language_boundary_error")
        if any(row["delivered_score"]["deletions"] for row in scores.values()):
            flags.append("deletion_present")
        if all(errors.values()):
            flags.append("both_models_wrong")
        if re.search(r"\d", left["reference"]):
            flags.append("numeric_reference")
        if re.search(r"\b[A-Z]{2,6}\b", left["reference"]):
            flags.append("possible_acronym")
        if any(repeated_output(row["text"] or "") for row in models.values()):
            flags.append("repetition_candidate")
        for variant, row in models.items():
            def unsimplified(text):
                units = TOKEN.findall(unicodedata.normalize("NFKC", text).lower())
                return list("".join(units)) if row["category"] == "zh" else units
            before = score_units(unsimplified(row["reference"]),
                                 unsimplified(row["text"] or "") if not row["failure"] else [])
            normalization[variant] += before["errors"] != errors[variant]
        flags_count.update(flags)
        pairs.append({
            "id": identifier, "category": left["category"], "reference": left["reference"],
            "sense_text": left["text"], "safe_encoder_text": right["text"],
            "sense_errors": errors["sense"], "safe_encoder_errors": errors["safe-encoder"],
            "winner": winner, "flags": flags, "review_status": "not_manually_verified",
        })
    return {
        "paired_samples": len(pairs), "wins": dict(wins), "flags": dict(flags_count),
        "normalization_changed_errors": dict(normalization),
        "normalization_comparison": "With vs without traditional-to-simplified; same other rules",
        "diagnostic_note": "Flags overlap and are not verified error causes; en/boundary S+D use one global alignment",
    }, pairs


def main(source, destination):
    source, destination = Path(source), Path(destination)
    rows = [json.loads(line) for line in (source / "scored-results.jsonl").read_text().splitlines()]
    summary, pairs = audit_pairs(rows)
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (destination / "paired-errors.json").write_text(json.dumps(pairs, ensure_ascii=False, indent=2) + "\n")
    review = []
    for winner in ("sense", "safe-encoder", "tie"):
        candidates = [row for row in pairs if row["winner"] == winner
                      and (row["sense_errors"] or row["safe_encoder_errors"])]
        ranked = sorted(candidates, key=lambda row: hashlib.sha256(f"review-v1:{row['id']}".encode()).hexdigest())
        review.extend(ranked[:15])
    with (destination / "review-candidates.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        fields = list(pairs[0]) + ["review_notes"] if pairs else []
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows({**row, "flags": ";".join(row["flags"]), "review_notes": ""} for row in review)
    for name in ("ATTRIBUTION.txt", "ASCEND-dataset-card.txt"):
        shutil.copyfile(source / name, destination / name)
    report = [
        "Paired ASCEND error audit", f"Paired utterances: {summary['paired_samples']}",
        f"Lower edit count per utterance: {summary['wins']}",
        f"Review flags (overlapping): {summary['flags']}",
        f"Script-normalization-sensitive utterances: {summary['normalization_changed_errors']}",
        f"Fixed hash-selected error review candidates: {len(review)} (up to 15 per winner/tie group).",
        "Review candidates are diagnostic only; the benchmark set and scores are unchanged.",
        "No automatic flag establishes a proper-name error or a bad reference transcript.",
        "Case and punctuation remain ignored in both sensitivity conditions.",
        "No semantic number rewriting, prompt changes or test-set parameter tuning.",
        "Rows remain unverified until independent listening; do not overwrite references.",
        "Open CSV columns as text; corpus strings are data, not spreadsheet formulas.",
    ]
    (destination / "REPORT.txt").write_text("\n".join(report) + "\n")
    print("\n".join(report), flush=True)


if __name__ == "__main__":
    import sys
    main(*sys.argv[1:])
