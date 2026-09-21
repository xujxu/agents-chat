"""Prepare only public ASCEND audio in CI; do not publish the audio artifact."""

import hashlib
import io
import json
from pathlib import Path
import re
import urllib.request

import pyarrow.parquet as pq
import soundfile as sf

from voice_accuracy_metrics import language, tokens


REVISION = "737e9800ae31be9932ba8464c80366559bd28424"
BASE = f"https://huggingface.co/datasets/CAiRE/ASCEND/resolve/{REVISION}"
FILES = {
    "validation": "3bdec53d2abfd3dd4f0d86a6df4e27e60f20660edc9b66055ae0ef8ec05cf7e2",
    "test": "a4c81d2b5ed6124f052089a695972808c16e0ce0c365ec9773c5d1a8fcf043a7",
}


def prepare():
    out = Path("artifacts")
    out.mkdir(exist_ok=True)
    samples = Path("accuracy-samples")
    samples.mkdir()
    urllib.request.urlretrieve(f"{BASE}/README.md", out / "ASCEND-dataset-card.txt")
    manifest = []
    for split, checksum in FILES.items():
        path = samples / f"{split}.parquet"
        urllib.request.urlretrieve(f"{BASE}/main/{split}-00000-of-00001.parquet", path)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == checksum, "Dataset hash mismatch"
        rows = pq.read_table(path).to_pylist()
        groups = {"mixed-word": [], "mixed-phrase": [], "zh": [], "en": []}
        for row in rows:
            if not 1 <= row["duration"] <= 30 or re.search(r"[\[\]<>]", row["transcription"]):
                continue
            units = tokens(row["transcription"])
            zh = sum(language(t) == "zh" for t in units)
            en = sum(language(t) == "en" for t in units)
            if zh and en:
                category = "mixed-phrase" if en >= 3 else "mixed-word"
            elif zh:
                category = "zh"
            elif en:
                category = "en"
            else:
                continue
            groups[category].append(row)
        for category, candidates in groups.items():
            count = (6 if split == "validation" else 12) if category.startswith("mixed") else (0 if split == "validation" else 3)
            ranked = sorted(candidates, key=lambda r: hashlib.sha256(
                f"accuracy-v1:{split}:{r['id']}".encode()).hexdigest())
            assert len(ranked) >= count, f"Not enough samples: {split}/{category}"
            for row in ranked[:count]:
                name = f"{split}-{row['id']}"
                audio, rate = sf.read(io.BytesIO(row["audio"]["bytes"]), dtype="float32")
                assert rate == 16000 and audio.ndim == 1, "Expected mono 16kHz corpus audio"
                duration = len(audio) / rate
                assert 0 < duration <= 30.05, "Unexpected audio length"
                sf.write(samples / f"{name}.wav", audio, rate, subtype="PCM_16")
                manifest.append({
                    "id": name, "split": split, "category": category,
                    "reference": row["transcription"], "duration": duration,
                    "speaker": row["original_speaker_id"], "session": row["session_id"],
                    "audio_sha256": hashlib.sha256((samples / f"{name}.wav").read_bytes()).hexdigest(),
                })
        del rows, groups
        path.unlink()
    sf.write(samples / "silence.wav", [0.0] * 80000, 16000, subtype="PCM_16")
    manifest.append({"id": "silence", "split": "control", "category": "silence",
                     "reference": "", "duration": 5})
    (out / "samples.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    (out / "methodology.json").write_text(json.dumps({
        "dataset": "CAiRE/ASCEND", "revision": REVISION, "sha256": FILES,
        "license": "CC-BY-SA-4.0", "attribution": "Lovenia et al., ASCEND, LREC 2022",
        "sampling": "hash-ranked fixed strata; no selection based on model output; exclude incomplete bracket-marked references such as [UNK]",
        "mixed_phrase": "at least 3 English words total; not necessarily a complete English sentence",
        "scoring": "micro MER; t2s + NFKC + lowercase + punctuation ignored; numbers unchanged",
        "limitations": [
            "Small screening subset, not a complete corpus benchmark or personal-voice accuracy.",
            "Potential pretraining overlap unknown; held-out here does not prove unseen during training.",
            "Audio is spontaneous conversation; isolated turns may depend on preceding context.",
            "English/Chinese S+D rates are global-alignment diagnostics, not standalone WER/CER.",
            "No private audio, answer hotwords, forced language, or text-only correction.",
            "CI CPU timings are not a guarantee for a future deployment machine.",
        ],
    }, indent=2))
    return manifest


if __name__ == "__main__":
    prepare()
