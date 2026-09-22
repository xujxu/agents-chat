"""Inventory pinned ASCEND partitions and extract only original long utterances in CI."""

from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import urllib.request

import pyarrow.parquet as pq
import soundfile as sf

from voice_accuracy_samples import BASE, REVISION
from voice_long_selection import describe, select


PARTS = {
    "test-00000-of-00001": "a4c81d2b5ed6124f052089a695972808c16e0ce0c365ec9773c5d1a8fcf043a7",
    "validation-00000-of-00001": "3bdec53d2abfd3dd4f0d86a6df4e27e60f20660edc9b66055ae0ef8ec05cf7e2",
    "train-00000-of-00003": "3d66ba76f324e0711b779cfb01ee4e772a24a929e1d77a2063cde0506f75976f",
    "train-00001-of-00003": "569f84f771c3637ca8535bd35e10e62feed2c240833534711909a9c04f51e589",
    "train-00002-of-00003": "aa76b7ef4a74ff111fd1d2573d0b69e6b6f901df6054618d8e5658a7a394523e",
}


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def prepare():
    out, audio_dir, cache = Path("artifacts"), Path("accuracy-samples"), Path("corpus")
    for path in (out, audio_dir, cache):
        path.mkdir(exist_ok=True)
    urllib.request.urlretrieve(f"{BASE}/README.md", out / "ASCEND-dataset-card.txt")
    candidates, inventory = [], []
    for part, checksum in PARTS.items():
        path = cache / f"{part}.parquet"
        urllib.request.urlretrieve(f"{BASE}/main/{part}.parquet", path)
        if digest(path) != checksum:
            raise ValueError(f"Corpus checksum mismatch: {part}")
        rows = pq.read_table(path, columns=["id", "duration", "transcription"]).to_pylist()
        split = part.split("-")[0]
        for index, row in enumerate(rows):
            row.update({"split": split, "part": part, "index": index})
        eligible = [r for r in rows if describe(r) is not None]
        candidates.extend(eligible)
        counts = dict(Counter("15-20" if r["duration"] < 20 else "20-25"
                             if r["duration"] < 25 else "25-30" for r in eligible))
        inventory.append({"part": part, "rows": len(rows), "eligible": len(eligible),
                          "eligible_duration_bands": counts})
        print(f"{part}: {len(eligible)} eligible original long mixed recordings", flush=True)
    selected = select(candidates, 40)
    manifest = []
    for part in PARTS:
        wanted = [r for r in selected if r["part"] == part]
        if not wanted:
            continue
        # Read one row group at a time: never materialize the entire corpus audio.
        parquet = pq.ParquetFile(cache / f"{part}.parquet")
        offset = 0
        for group in range(parquet.num_row_groups):
            size = parquet.metadata.row_group(group).num_rows
            group_rows = [r for r in wanted if offset <= r["index"] < offset + size]
            if group_rows:
                table = parquet.read_row_group(group, columns=["audio"])
                for row in group_rows:
                    data = table.slice(row["index"] - offset, 1).to_pylist()[0]["audio"]
                    audio, rate = sf.read(io.BytesIO(data["bytes"]), dtype="float32")
                    duration = len(audio) / rate
                    if rate != 16000 or audio.ndim != 1 or not 15 <= duration <= 30:
                        raise ValueError(f"Actual audio violates selection bounds: {row['id']} {duration}")
                    name = f"{row['split']}-{row['id']}"
                    target = audio_dir / f"{name}.wav"
                    sf.write(target, audio, rate, subtype="PCM_16")
                    manifest.append({
                        "id": name, "split": row["split"], "category": "mixed-long",
                        "reference": row["transcription"], "duration": duration,
                        "audio_sha256": digest(target), **describe(row),
                    })
                del table
            offset += size
    manifest.sort(key=lambda r: r["id"])
    if not manifest:
        raise ValueError("No genuine long mixed audio found; do not substitute synthetic data")
    report = {
        "dataset": "CAiRE/ASCEND", "revision": REVISION, "sha256": PARTS,
        "license": "CC-BY-SA-4.0", "attribution": "Lovenia et al., ASCEND, LREC 2022",
        "inventory": inventory, "requested": 40, "selected": len(manifest),
        "shortfall_to_minimum_30": max(0, 30 - len(manifest)),
        "selected_splits": dict(Counter(r["split"] for r in manifest)),
        "selection": "original 15-30s mixed utterances, no unknown annotation; test/validation preferred then train; hash rank, no output-conditioned selection",
        "english_runs_at_least_3": sum(r["longest_english_run"] >= 3 for r in manifest),
        "gaps": [
            "Consecutive English words do not prove a grammatically complete English sentence.",
            "Transcript language switches do not prove an acoustically pause-free switch.",
            "Training-split probes are explicitly labeled, not an unseen-test claim.",
            "Model pretraining overlap unknown for every split.",
            "No private user audio; no stitched, truncated or silence-padded speech.",
        ],
    }
    sf.write(audio_dir / "silence.wav", [0.0] * 80000, 16000, subtype="PCM_16")
    manifest.append({"id": "silence", "split": "control", "category": "silence",
                     "reference": "", "duration": 5})
    (out / "samples.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    (out / "coverage.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    prepare()
