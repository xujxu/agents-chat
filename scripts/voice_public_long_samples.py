"""CI-only extraction of continuous public YODAS2 waveform windows.

Captions are unverified selection hints, never ASR scoring references.
No speech segments are concatenated, no silence removed or synthesized.
"""

from collections import Counter
import csv
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

import soundfile as sf

from voice_long_samples import digest
from voice_public_windows import choose, windows


REVISION = "c9674490249665d658f527e2684848377108d82c"
BASE = f"https://huggingface.co/datasets/espnet/yodas2/resolve/{REVISION}"
ARCHIVES = {
    "00000000": "06dbb784f722a1d9ab245e6f72c108c2405e9c36605768efbaba35289777fc46",
    "00000001": "b2e82ac3a1207cd858e92813d49885571616955581d42ee2daaf278c0ee3b59a",
}


def main():
    out, clips, cache = Path("artifacts"), Path("accuracy-samples"), Path("public-corpus")
    for path in (out, clips, cache):
        path.mkdir(exist_ok=True)
    urllib.request.urlretrieve(f"{BASE}/README.md", out / "YODAS2-dataset-card.txt")
    candidates, inventory = [], []
    for shard in ARCHIVES:
        path = cache / f"{shard}.json"
        url = f"{BASE}/data/zh000/text/{shard}.json"
        urllib.request.urlretrieve(url, path)
        videos = json.loads(path.read_text())
        rows = [dict(candidate, shard=shard) for video in videos for candidate in windows(video)]
        inventory.append({"shard": shard, "videos": len(videos), "candidate_windows": len(rows),
                          "caption_url": url, "caption_sha256": digest(path)})
        candidates.extend(rows)
    selected = choose(candidates)
    report = {
        "source": "espnet/yodas2", "revision": REVISION, "license": "CC-BY-3.0",
        "attribution": "Li et al., YODAS, ASRU 2023; original media attributed through source identifiers and archive paths",
        "requested": 40, "selected": len(selected), "shortfall_to_30": max(0, 30 - len(selected)),
        "inventory": inventory, "archive_sha256": ARCHIVES,
        "caption_status": "UNVERIFIED; user-uploaded captions may be machine-generated",
        "accuracy_scoring": "DISABLED until independent human transcript verification",
        "method": "single continuous 15-30s cut from original video-level waveform; preserves pauses; captions only guide boundaries",
        "gaps": ["English token runs do not verify complete spoken English sentences.",
                 "Pause-free language switching, overlap, accents and recording quality require listening.",
                 "Caption language may not match spoken language; reviewers must reject such clips.",
                 "Only two fixed Mandarin shards screened; no population-representativeness claim."],
    }
    (out / "coverage.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
    if not selected:
        raise SystemExit("No eligible public candidates; do not substitute synthetic audio")
    manifest = []
    for shard, checksum in ARCHIVES.items():
        wanted = [c for c in selected if c["shard"] == shard]
        if not wanted:
            continue
        archive = cache / f"{shard}.tar.gz"
        archive_url = f"{BASE}/data/zh000/audio/{shard}.tar.gz"
        urllib.request.urlretrieve(archive_url, archive)
        if digest(archive) != checksum:
            raise ValueError(f"Original audio archive checksum mismatch: {shard}")
        found = set()
        with tarfile.open(archive, "r|gz") as stream:
            for member in stream:
                if not member.isfile():
                    continue
                matches = [c for c in wanted if c["video"] == Path(member.name).stem]
                if not matches:
                    continue
                original = cache / "current-audio"
                with stream.extractfile(member) as source, original.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                for candidate in matches:
                    video = candidate["video"]
                    if not re.fullmatch(r"[A-Za-z0-9_-]+", video):
                        raise ValueError("Unexpected source identifier")
                    identifier = f"yodas2-{shard}-{video}-{round(candidate['start'] * 100)}"
                    destination = clips / f"{identifier}.wav"
                    subprocess.run(["ffmpeg", "-v", "error", "-i", str(original),
                                    "-ss", str(candidate["start"]), "-t", str(candidate["duration"]),
                                    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(destination)], check=True)
                    info = sf.info(destination)
                    if info.samplerate != 16000 or info.channels != 1 or not 15 <= info.duration <= 30:
                        raise ValueError(f"Actual candidate violates bounds: {identifier} {info.duration}")
                    if abs(info.duration - candidate["duration"]) > 0.02:
                        raise ValueError(f"Source shorter than selected caption range: {identifier}")
                    manifest.append({
                        **candidate, "id": identifier, "duration": info.duration,
                        "reference": "", "split": "unverified", "category": "mixed-long-candidate",
                        "audio_sha256": digest(destination), "source_url": archive_url,
                        "archive_member": member.name, "review_status": "pending",
                    })
                    found.add(identifier)
                original.unlink()
        if len(found) != len(wanted):
            raise ValueError(f"Missing or duplicate original waveforms in {shard}: {len(found)}/{len(wanted)}")
        archive.unlink()
    manifest.sort(key=lambda c: c["id"])
    (out / "samples.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    with (out / "human-review.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["id", "duration", "source_url", "archive_member", "start", "end",
                         "caption_unverified", "verified_transcript", "accept_or_reject",
                         "natural_mixed_speech", "full_english_sentence", "pause_free_switch", "notes"])
        for c in manifest:
            writer.writerow([c["id"], c["duration"], c["source_url"], c["archive_member"],
                             c["start"], c["end"], c["caption"], "", "", "", "", "", ""])
    (clips / "ATTRIBUTION.txt").write_text(
        f"Source: espnet/yodas2 revision {REVISION}\nLicense: CC-BY-3.0 "
        "(https://creativecommons.org/licenses/by/3.0/)\n"
        "Li et al., YODAS: Youtube-Oriented Dataset for Audio and Speech, ASRU 2023.\n"
        "Changes: continuous time-window extraction and mono PCM16 resampling to 16kHz.\n"
        "See samples.json for original archive/member, timestamps and caption identifiers.\n"
        "Captions are not verified transcripts. No accuracy score is authorized by this candidate set.\n")
    for name in ("samples.json", "human-review.csv", "YODAS2-dataset-card.txt"):
        shutil.copyfile(out / name, clips / name)
    print("Candidate duration bands:", dict(Counter(
        "15-20" if c["duration"] < 20 else "20-25" if c["duration"] < 25 else "25-30" for c in manifest)))


if __name__ == "__main__":
    main()
