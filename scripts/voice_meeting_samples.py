"""Select continuous, fully annotated AISHELL-4 test windows without audio splicing."""

from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile

from voice_accuracy_metrics import language, tokens


SOURCE = "https://openslr.trmal.net/resources/111/test.tar.gz"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def continuous_windows(meeting, intervals):
    speech = sorted((row for row in intervals if row["text"].strip()), key=lambda row: (row["start"], row["end"]))
    candidates = []
    for i, first in enumerate(speech):
        if any(row["end"] > first["start"] for row in speech[:i]):
            continue
        start, end, voiced, parts = first["start"], first["start"], 0, []
        for j in range(i, len(speech)):
            row = speech[j]
            if row["start"] < end or row["end"] <= row["start"]:
                break
            if re.search(r"[<>\[\]{}()%$（）]", row["text"]):
                break
            if row["end"] - start > 30 or row["start"] - end > 2:
                break
            end = row["end"]
            voiced += end - row["start"]
            parts.append(row["text"].strip())
            # A later tier's interval may begin inside this final utterance.
            if j + 1 < len(speech) and speech[j + 1]["start"] < end:
                continue
            duration = end - start
            if duration < 15 or voiced / duration < 0.5:
                continue
            reference = " ".join(parts)
            langs = {language(unit) for unit in tokens(reference)}
            if "zh" not in langs:
                continue
            identifier = f"aishell4-{meeting}-{round(start * 16000)}-{round(end * 16000)}"
            candidates.append({
                "id": identifier, "meeting": meeting, "start": start, "end": end,
                "duration": duration, "voiced_seconds": voiced, "reference": reference,
                "category": "mixed" if "en" in langs else "zh", "split": "test",
            })
    return candidates


def choose_windows(candidates, count=40):
    ranked = sorted(candidates, key=lambda row: (
        row["category"] != "mixed", hashlib.sha256(f"meeting-v1:{row['id']}".encode()).hexdigest()))
    selected = []
    for row in ranked:
        same_meeting = [old for old in selected if old["meeting"] == row["meeting"]]
        if len(same_meeting) >= 4 or any(row["start"] < old["end"] and old["start"] < row["end"]
                                         for old in same_meeting):
            continue
        selected.append(row)
        if len(selected) == count:
            break
    return sorted(selected, key=lambda row: row["id"])


def prepare(archive, destination):
    import soundfile as sf
    import textgrid

    archive, destination = Path(archive), Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    audio_dir = destination / "audio"
    audio_dir.mkdir()
    grids, waveforms, candidates = {}, {}, []
    with tempfile.TemporaryDirectory() as temporary:
        temporary = Path(temporary)
        with tarfile.open(archive, "r|gz") as stream:
            for member in stream:
                if not member.isfile():
                    continue
                name = Path(member.name)
                if name.suffix.lower() not in (".wav", ".flac", ".textgrid"):
                    continue
                if not re.fullmatch(r"[A-Za-z0-9_-]+", name.stem):
                    raise ValueError(f"Unsafe recording identifier: {name.stem}")
                if name.suffix.lower() in (".wav", ".flac"):
                    if name.stem in waveforms:
                        raise ValueError("Duplicate recording")
                    waveforms[name.stem] = member.name
                elif name.suffix.lower() == ".textgrid":
                    if name.stem in grids:
                        raise ValueError("Duplicate annotation")
                    path = temporary / "annotation.TextGrid"
                    with stream.extractfile(member) as source, path.open("wb") as target:
                        shutil.copyfileobj(source, target)
                    grid = textgrid.TextGrid.fromFile(str(path))
                    intervals = [{"start": float(item.minTime), "end": float(item.maxTime),
                                  "text": item.mark, "speaker": str(index)}
                                 for index, tier in enumerate(grid) for item in tier]
                    grids[name.stem] = {"member": member.name, "sha256": digest(path),
                                       "intervals": len(intervals)}
                    candidates.extend(continuous_windows(name.stem, intervals))
        if not grids or set(grids) - waveforms.keys():
            raise ValueError("Missing meeting annotations or matching original recordings")
        selected = choose_windows(candidates)
        coverage = {
            "dataset": "AISHELL-4", "source_url": SOURCE, "archive_sha256": digest(archive),
            "license": "CC-BY-SA-4.0", "recordings": len(waveforms), "annotations": grids,
            "eligible_windows": len(candidates), "eligible_categories": dict(Counter(r["category"] for r in candidates)),
            "selected": len(selected), "selected_categories": dict(Counter(r["category"] for r in selected)),
            "requested": 40, "shortfall": max(0, 40 - len(selected)),
            "method": "Original continuous 15-30s source windows, full annotation boundaries, pauses retained; no overlap/unknown marks; channel0 only",
            "selection": "Mixed first then fixed hash; no model outputs; <=4 nonoverlapping windows per meeting",
            "gaps": [
                "Meeting acoustics are not a personal microphone sample.",
                "English annotation tokens do not prove fluent full-sentence code-switching.",
                "No complete long mixed-language coverage claim if selected mixed count is small.",
                "Manual reference provenance from dataset publisher, not independently re-transcribed here.",
                "No published SHA-256 located; HTTPS acquisition checksum recorded for pinning this exact artifact.",
            ],
        }
        (destination / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
        if not selected:
            raise ValueError("No eligible natural windows; do not fabricate substitutes")
        wanted = {waveforms[row["meeting"]] for row in selected}
        with tarfile.open(archive, "r|gz") as stream:
            for member in stream:
                if member.name not in wanted:
                    continue
                original = temporary / "recording"
                with stream.extractfile(member) as source, original.open("wb") as target:
                    shutil.copyfileobj(source, target)
                with sf.SoundFile(original) as recording:
                    if recording.samplerate != 16000:
                        raise ValueError("Expected original 16kHz meeting recording")
                    for row in selected:
                        if waveforms[row["meeting"]] != member.name:
                            continue
                        begin, end = round(row["start"] * 16000), round(row["end"] * 16000)
                        recording.seek(begin)
                        audio = recording.read(end - begin, dtype="int16", always_2d=True)
                        if len(audio) != end - begin:
                            raise ValueError("Truncated source recording")
                        path = audio_dir / f"{row['id']}.wav"
                        sf.write(path, audio[:, 0], 16000, subtype="PCM_16")
                        row.update({"audio_sha256": digest(path), "duration": len(audio) / 16000,
                                    "source_member": member.name, "source_channel": 0,
                                    "annotation_sha256": grids[row["meeting"]]["sha256"]})
                original.unlink()
        if any("audio_sha256" not in row for row in selected):
            raise ValueError("Selected source recording missing")
    (destination / "samples.json").write_text(json.dumps(selected, ensure_ascii=False, indent=2) + "\n")
    (destination / "ATTRIBUTION.txt").write_text(
        "AISHELL-4, Beijing Shell Shell Technology Co.,Ltd; Fu et al., Interspeech 2021.\n"
        "https://openslr.org/111/ ; https://arxiv.org/abs/2104.03603\n"
        "CC-BY-SA-4.0 https://creativecommons.org/licenses/by-sa/4.0/\n"
        "Changes: channel0 and continuous windows extracted, transcripts joined in source-time order.\n"
        "Audio is not concatenated, synthesized, denoised or pause-trimmed.\n")
    print(json.dumps({key: value for key, value in coverage.items() if key != "annotations"}), flush=True)


if __name__ == "__main__":
    import sys
    prepare(*sys.argv[1:])
