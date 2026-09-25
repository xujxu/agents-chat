import copy
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from voice_feature_data import sha
from voice_webkit_evidence import validate_metadata
from voice_webkit_signal import (CASE, COMMITS, DECOMPOSITION_COMMIT, DECOMPOSITION_RUN, IDS, INPUTS,
                                 SOURCE_COMMIT, SOURCE_RUN, load_pairs)


def fixture(root):
    for name in ("source/audio", "webkit/captured", "decomposition"):
        (root / name).mkdir(parents=True)
    n = 96000
    raw = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36+n*2, b"WAVE", b"fmt ", 16,
                      1, 1, 16000, 32000, 2, 16, b"data", n*2) + struct.pack("<h", 100)*n
    samples, rows, previous = [], [], []
    for sid in IDS:
        sample = {"id": sid, "reference": "hello world", "category": "mixed", "duration": 6,
                  "dataset": "ASCEND", "split": "test", "audio_sha256": sha(raw)}
        samples.append(sample)
        rows.append({**sample, "pipeline": "browser", "uploadedAudioSha256": sha(raw), "uploadedDuration": 6,
                     "capture": {"sourceCompleted": True}, "timing": {"stopKind": "manual"}})
        previous.append({**sample, "caseId": CASE, "uploadedAudioSha256": sha(raw), "uploadedDuration": 6,
                         "contrasts": {"primary": {"errors": 0, "percentage_points": 0}}})
        (root / "source/audio" / f"{sid}.wav").write_bytes(raw)
        (root / "webkit/captured" / f"{sid}.wav").write_bytes(raw)
    (root / "source/samples.json").write_text(json.dumps(samples))
    (root / "decomposition/samples.json").write_text(json.dumps(previous))
    (root / "decomposition/summary.json").write_text(json.dumps({
        "status": "complete", "caseId": CASE, "samples": 8, "matches_saved": True,
        "source": {"run": SOURCE_RUN, "commit": SOURCE_COMMIT},
        "analysis": {"run": DECOMPOSITION_RUN, "commit": DECOMPOSITION_COMMIT},
    }))
    return samples, rows, {}


class SignalEvidenceTests(unittest.TestCase):
    def test_fixed_inputs_use_their_own_historical_commits(self):
        for key, (artifact_id, run, name, digest) in INPUTS.items():
            metadata = {"id": int(artifact_id), "expired": False, "name": name, "digest": "sha256:" + digest,
                        "workflow_run": {"id": int(run), "head_sha": COMMITS[key]}}
            self.assertEqual(validate_metadata(metadata, key, INPUTS, COMMITS), digest)
            metadata["workflow_run"]["head_sha"] = "new-signal-analysis"
            with self.assertRaises(ValueError):
                validate_metadata(metadata, key, INPUTS, COMMITS)

    def test_eight_pairs_and_reject_source_upload_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = fixture(root)
            with patch("voice_webkit_signal.load_platform", return_value=data) as loader:
                pairs = list(load_pairs(root))
                self.assertEqual([m["id"] for m, _, _ in pairs], list(IDS))
                self.assertEqual(len(pairs[0][1]), 96000)
                loader.assert_called_with(root / "webkit", "linux", SOURCE_RUN, SOURCE_COMMIT, CASE)
                for subdir in ("source/audio", "webkit/captured"):
                    path = root / subdir / f"{IDS[0]}.wav"
                    original = path.read_bytes()
                    path.write_bytes(original[:-1] + b"x")
                    with self.assertRaisesRegex(ValueError, "checksum"):
                        list(load_pairs(root))
                    path.write_bytes(original)

    def test_stale_missing_duplicate_and_changed_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = fixture(root)
            with patch("voice_webkit_signal.load_platform", return_value=data):
                for name, mutation in (
                    ("source/samples.json", lambda rows: rows[:-1]),
                    ("source/samples.json", lambda rows: rows + [rows[0]]),
                    ("decomposition/samples.json", lambda rows: rows + [rows[0]]),
                    ("decomposition/samples.json", lambda rows: [{**rows[0], "uploadedAudioSha256": "0"*64}, *rows[1:]]),
                    ("decomposition/samples.json", lambda rows: [{**rows[0], "reference": "wrong"}, *rows[1:]]),
                    ("decomposition/summary.json", lambda row: {**row, "source": {"run": "new", "commit": SOURCE_COMMIT}}),
                    ("decomposition/summary.json", lambda row: {**row, "analysis": {"run": DECOMPOSITION_RUN, "commit": "new"}}),
                ):
                    path = root / name
                    original = path.read_text()
                    path.write_text(json.dumps(mutation(json.loads(original))))
                    with self.subTest(file=name), self.assertRaises(ValueError):
                        list(load_pairs(root))
                    path.write_text(original)
                changed = copy.deepcopy(data)
                changed[0][0]["duration"] = 5
                with patch("voice_webkit_signal.load_platform", return_value=changed), self.assertRaises(ValueError):
                    list(load_pairs(root))


if __name__ == "__main__":
    unittest.main()
