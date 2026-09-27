"""Package existing PCM audio for human transcription, without reference text."""

import csv
import hashlib
import io
import json
import os
from pathlib import Path
import random
import re
import shutil
import sys
import wave


COUNT = 40
SEED = 20260922
REVISION = "c9674490249665d658f527e2684848377108d82c"
INSTRUCTIONS = """BLIND LISTENING: 40 AUDIO CLIPS

Open audio/01.wav through audio/40.wav and record only what you hear in the
matching row of transcripts.csv. The transcript and notes columns are blank.
You may replay clips. Do not consult source captions, model outputs or the
separate mapping artifact until your transcription is finished.

Keep all 40 rows and the existing id column. If a spreadsheet displays 01 as 1,
it still means audio/01.wav; do not reorder or renumber the IDs.
Write the spoken languages as heard, without translating or paraphrasing.
Mark an unintelligible span as [inaudible] and explain uncertainties in notes.
If a whole clip cannot be transcribed, leave transcript blank and explain why
in notes. Silence, overlap or unsuitable audio should also be noted.
Uncertain or missing text must be reviewed before accuracy scoring.

Save as CSV UTF-8, not XLSX, preserving the id,transcript,notes columns.
The CSV includes a UTF-8 BOM for spreadsheet compatibility. Use a CSV-aware
editor so commas, quotation marks and line breaks in your text are escaped.
Return the completed CSV; no audio upload is necessary.

Audio is the original selected PCM waveform, not synthesized or re-segmented.
Only filenames/order and WAV container metadata changed. Each clip is 15-30s.
This is a listening exercise, not proof of language content or ASR accuracy.
The source-ID key and detailed source attribution are kept separately to avoid
revealing source identities during transcription. Do not open that artifact
before finishing. It is separate, not access-controlled.
"""
ATTRIBUTION = f"""Source: espnet/yodas2, revision {REVISION}
Dataset: https://huggingface.co/datasets/espnet/yodas2/tree/{REVISION}
License: CC-BY-3.0 (https://creativecommons.org/licenses/by/3.0/)
Li et al., YODAS: Youtube-Oriented Dataset for Audio and Speech, ASRU 2023.
Prior changes: continuous time-window extraction; mono PCM16 at 16 kHz.
Blind-package changes: shuffled numbered filenames and removal of WAV metadata.
No PCM sample, silence, timing or speech content was changed.
Per-clip source URLs, archive members and extraction times are preserved in the
separate voice-blind-key-do-not-open-before-transcribing artifact (mapping.json).
Please consult that source attribution after completing the blind transcription.
"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_audio(source, row):
    path = source / f"{row['id']}.wav"
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Missing or unsafe audio: {row['id']}")
    data = path.read_bytes()
    if digest(data) != row["audio_sha256"]:
        raise ValueError(f"Audio checksum mismatch: {row['id']}")
    try:
        with wave.open(io.BytesIO(data), "rb") as stream:
            params = stream.getparams()
            frames = stream.readframes(params.nframes)
    except (wave.Error, EOFError) as error:
        raise ValueError(f"Invalid WAV: {row['id']}") from error
    if (params.nchannels, params.sampwidth, params.framerate, params.comptype) != (1, 2, 16000, "NONE"):
        raise ValueError(f"Expected mono PCM16 at 16 kHz: {row['id']}")
    duration = params.nframes / params.framerate
    if not 15 <= duration <= 30 or abs(duration - row["duration"]) > 0.02:
        raise ValueError(f"Invalid audio duration: {row['id']}")
    if len(frames) != params.nframes * params.nchannels * params.sampwidth:
        raise ValueError(f"Truncated PCM audio: {row['id']}")
    return params, frames


def package(source, output):
    source, output = Path(source), Path(output)
    rows = json.loads((source / "samples.json").read_text(encoding="utf-8"))
    if not isinstance(rows, list) or len(rows) != COUNT:
        raise ValueError(f"Exactly {COUNT} source clips are required")
    required = {"id", "audio_sha256", "duration", "source_url", "archive_member", "start", "end"}
    for row in rows:
        if not isinstance(row, dict) or not required <= row.keys():
            raise ValueError("Source manifest lacks required provenance fields")
        if not isinstance(row["id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]+", row["id"]):
            raise ValueError("Unsafe source identifier")
    if len({row["id"] for row in rows}) != COUNT:
        raise ValueError("Duplicate source identifier")
    rows.sort(key=lambda row: row["id"])
    random.Random(SEED).shuffle(rows)
    output.mkdir(parents=True, exist_ok=False)
    blind, key = output / "blind", output / "key"
    (blind / "audio").mkdir(parents=True)
    key.mkdir()
    mapping = []
    for index, row in enumerate(rows, 1):
        identifier = f"{index:02d}"
        params, frames = read_audio(source, row)
        target = blind / "audio" / f"{identifier}.wav"
        # Rebuild only the container, stripping source-identifying ancillary chunks.
        with wave.open(str(target), "wb") as stream:
            stream.setparams(params)
            stream.writeframes(frames)
        with wave.open(str(target), "rb") as stream:
            if stream.getparams() != params or stream.readframes(params.nframes) != frames:
                raise ValueError(f"PCM preservation check failed: {identifier}")
        mapping.append({
            "blind_id": identifier, "source_id": row["id"],
            "source_sha256": row["audio_sha256"], "blind_sha256": digest(target.read_bytes()),
            "pcm_sha256": digest(frames), "duration": params.nframes / params.framerate,
            **{field: row[field] for field in ("source_url", "archive_member", "start", "end")},
        })
    with (blind / "transcripts.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["id", "transcript", "notes"])
        writer.writerows([row["blind_id"], "", ""] for row in mapping)
    (blind / "README.txt").write_text(INSTRUCTIONS, encoding="utf-8")
    (blind / "ATTRIBUTION.txt").write_text(ATTRIBUTION, encoding="utf-8")
    (key / "mapping.json").write_text(json.dumps(mapping, indent=2) + "\n", encoding="utf-8")
    (key / "provenance.json").write_text(json.dumps({
        "source_run": "35731913423", "source_artifact": "10695264903",
        "dataset_revision": REVISION, "package_commit": os.environ.get("GITHUB_SHA"),
        "source_manifest_sha256": digest((source / "samples.json").read_bytes()),
        "shuffle_seed": SEED, "count": COUNT, "accuracy_scoring": "pending human transcription",
    }, indent=2) + "\n", encoding="utf-8")
    (output / "csv").mkdir()
    shutil.copyfile(blind / "transcripts.csv", output / "csv" / "transcripts.csv")
    print(f"Packaged {COUNT} numbered WAVs; all PCM frames verified unchanged.")
    print("CSV: 40 blank transcript/notes rows; source mapping stored separately.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: voice_blind_package.py SOURCE_DIRECTORY OUTPUT_DIRECTORY")
    package(sys.argv[1], sys.argv[2])
