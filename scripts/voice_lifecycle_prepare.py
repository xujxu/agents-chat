"""Prepare two retained speech inputs and one verified candidate package in Actions."""

import json
import os
from pathlib import Path
import shutil
import sys
import wave

from voice_webkit_evidence import download, file_hash

SOURCE = ("10748244312", "35858271102", "ascend-test-corpus",
          "8f81879b98c3a64c557a9c7772fbb5b988b408018e6313800c96efb3ebc5fda0")
PACKAGES = {
    "linux": ("10794617845", "35968099304", "voice-install-sensevoice-small-q8",
              "e2be50235ba3f584833750c444c313dd3aa4231c65a6eb1c222e18c06e0e7295"),
    "win32": ("10802394350", "35987278609",
              "voice-windows-candidate-sensevoice-small-q8-86fa6716eceaf4254fb020664338fcadcce37868",
              "2796a7666cf36f1f9597af1978af1df1feeec648bbca1036a226cb99ddebe3ab"),
}
COMMITS = {"linux": "a2f15bff3c05b94433855ce9d16056cac1296133",
           "win32": "86fa6716eceaf4254fb020664338fcadcce37868"}
MANIFESTS = {"linux": "ccf50b7ddaef5f9a0cddd58f87c4f08421902c630b2ca2a485bfebaae727f40c",
             "win32": "ed605fe13aacaf21d0aceb18127d6bccb0a1099f561aa0ecef95952975cae905"}
IDS = ["test-00332", "test-00949"]


def prepare(host):
    if os.environ.get("GITHUB_ACTIONS") != "true" or host not in PACKAGES:
        raise ValueError("Supported Actions host required")
    root = Path("lifecycle-inputs")
    provenance = download(root, {"source": SOURCE, "package": PACKAGES[host]},
                          {"source": "1f773d5996f5d684ce1570705b6bb2344beee264",
                           "package": COMMITS[host]})
    if file_hash(root / "package/voice-package.json") != MANIFESTS[host]:
        raise ValueError("Unexpected package manifest")
    metadata = json.loads((root / "source/samples.json").read_text(encoding="utf-8"))
    selected = []
    (root / "speech").mkdir()
    for sid in IDS:
        matches = [sample for sample in metadata if sample["id"] == sid]
        if len(matches) != 1:
            raise ValueError("Missing or duplicate fixed source")
        sample = matches[0]
        source = root / "source/audio" / f"{sid}.wav"
        if file_hash(source) != sample["audio_sha256"] or sample["split"] != "test":
            raise ValueError("Source identity differs")
        with wave.open(str(source)) as wav:
            if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) != (1, 16000, 2):
                raise ValueError("Invalid source format")
            duration = wav.getnframes() / wav.getframerate()
        if abs(duration - sample["duration"]) > 1 / 16000 or not 0 < duration < 30:
            raise ValueError("Source duration differs")
        shutil.copyfile(source, root / "speech" / f"{sid}.wav")
        selected.append({key: sample[key] for key in ("id", "duration", "audio_sha256", "split")})
    (root / "samples.json").write_text(json.dumps(selected, indent=2), encoding="utf-8")
    output = Path("lifecycle-evidence")
    output.mkdir(exist_ok=True)
    (output / "inputs.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    shutil.copyfile(root / "source/ATTRIBUTION.txt", output / "ASCEND-ATTRIBUTION.txt")


if __name__ == "__main__":
    prepare(sys.argv[1])
