"""Pinned ASCEND test split only; keep every inclusion/exclusion decision."""

from collections import Counter
import io
import json
import math
from pathlib import Path
import re
import urllib.request

from voice_accuracy_metrics import language, tokens


def select_rows(rows):
    selected, inventory, seen = [], [], set()
    for index, row in enumerate(rows):
        identifier = row["id"]
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", identifier):
            raise ValueError("Unsafe corpus identifier")
        if identifier in seen:
            raise ValueError("Duplicate corpus identifier")
        seen.add(identifier)
        text, duration = row["transcription"], row["duration"]
        units = tokens(text)
        languages = {language(unit) for unit in units}
        category = "mixed" if {"zh", "en"} <= languages else (
            "zh" if "zh" in languages else "en" if "en" in languages else None)
        reason = None
        if not math.isfinite(duration) or not 0 < duration <= 30:
            reason = "outside_0_to_30_seconds"
        elif re.search(r"[\[\]<>]", text):
            reason = "incomplete_or_special_annotation"
        elif category is None:
            reason = "no_chinese_or_english_reference_units"
        item = {
            "id": f"test-{identifier}", "source_id": identifier, "split": "test",
            "reference": text, "duration": duration if math.isfinite(duration) else None,
            "category": category, "source_index": index,
        }
        inventory.append({**item, "included": reason is None, "reason": reason})
        if reason is None:
            selected.append(item)
    return selected, inventory


def prepare(destination):
    import pyarrow.parquet as pq
    import soundfile as sf
    from voice_accuracy_samples import BASE, FILES, REVISION
    from voice_long_samples import digest

    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    cache = destination / "test.parquet"
    urllib.request.urlretrieve(f"{BASE}/main/test-00000-of-00001.parquet", cache)
    if digest(cache) != FILES["test"]:
        raise ValueError("Pinned ASCEND test checksum mismatch")
    parquet = pq.ParquetFile(cache)
    rows = parquet.read(columns=["id", "duration", "transcription"]).to_pylist()
    if len(rows) != 1315:
        raise ValueError("Pinned ASCEND test row count changed")
    selected, inventory = select_rows(rows)
    if not selected:
        raise ValueError("No usable test references")
    wanted = {row["source_index"]: row for row in selected}
    audio_dir = destination / "audio"
    audio_dir.mkdir()
    offset = 0
    for batch in parquet.iter_batches(batch_size=32, columns=["audio"]):
        for index, data in enumerate(batch.to_pylist(), offset):
            if index not in wanted:
                continue
            item = wanted[index]
            audio, rate = sf.read(io.BytesIO(data["audio"]["bytes"]), dtype="int16")
            duration = len(audio) / rate
            if rate != 16000 or audio.ndim != 1 or abs(duration - item["duration"]) > 0.02:
                raise ValueError(f"Unexpected waveform: {item['id']}")
            path = audio_dir / f"{item['id']}.wav"
            sf.write(path, audio, rate, subtype="PCM_16")
            item.update({"duration": duration, "audio_sha256": digest(path)})
        offset += batch.num_rows
    if any("audio_sha256" not in row for row in selected):
        raise ValueError("Missing selected waveforms")
    cache.unlink()
    (destination / "samples.json").write_text(
        json.dumps(selected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (destination / "inventory.json").write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    coverage = {
        "dataset": "CAiRE/ASCEND", "revision": REVISION, "test_sha256": FILES["test"],
        "total_rows": len(rows), "included": len(selected), "excluded": len(rows) - len(selected),
        "categories": dict(Counter(row["category"] for row in selected)),
        "exclusions": dict(Counter(row["reason"] for row in inventory if not row["included"])),
        "duration_bands": dict(Counter(
            "0-5" if row["duration"] < 5 else "5-15" if row["duration"] < 15 else "15-30"
            for row in selected)),
        "license": "CC-BY-SA-4.0", "reference_provenance": "ASCEND expert-generated corpus annotations",
        "selection": "All eligible official test rows, no sampling or model-output-conditioned selection",
        "scope": "Engine baseline, not browser/API/VAD pipeline; no model tuning on this test split",
        "overlap": "Prior exploratory subsets used this split; model pretraining overlap unknown",
    }
    (destination / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
    urllib.request.urlretrieve(f"{BASE}/README.md", destination / "ASCEND-dataset-card.txt")
    (destination / "ATTRIBUTION.txt").write_text(
        "ASCEND: Lovenia et al., LREC 2022. https://huggingface.co/datasets/CAiRE/ASCEND\n"
        "CC-BY-SA-4.0: https://creativecommons.org/licenses/by-sa/4.0/\n"
        f"Revision: {REVISION}\n"
        "Changes: selected eligible official test utterances; exported mono PCM16 WAVs;\n"
        "derived normalized scoring, engine outputs and metrics. Retain attribution and license.\n")
    print(json.dumps(coverage), flush=True)


if __name__ == "__main__":
    import sys
    prepare(sys.argv[1])
