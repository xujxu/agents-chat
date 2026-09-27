import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from test_voice_browser_report import fixture
from voice_browser_baseline import parse_text
from voice_browser_evidence import captured_duration, load_platform
from voice_feature_data import sha


class BrowserEvidenceTests(unittest.TestCase):
    def test_bounded_canonical_signal_and_baseline_json(self):
        wav = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36+32000, b"WAVE", b"fmt ", 16,
                          1, 1, 16000, 32000, 2, 16, b"data", 32000) + struct.pack("<h", 100) * 16000
        self.assertEqual(captured_duration(wav), 1)
        for bad in (wav[:-1], wav + b"x", wav[:44] + bytes(32000)):
            with self.assertRaises(ValueError):
                captured_duration(bad)
        self.assertEqual(parse_text('prefix\n  {"text":"hello","tokens":[]}\n'), "hello")
        for bad in ('{"text":""}', '{"text":"one"}\n{"text":"two"}', 'invalid'):
            with self.assertRaises(ValueError):
                parse_text(bad)

    def test_artifact_identity_and_captured_bytes(self):
        samples, all_rows, _, _ = fixture()
        rows = [r for r in all_rows if r["platform"] == "linux"]
        manifest = {"files": [{"role": r, "sha256": sha(r.encode())} for r in ("binary", "model")]}
        raw = json.dumps(manifest).encode()
        identity = {"manifest": sha(raw), "binary": sha(b"binary"), "model": sha(b"model"), "helper": None}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "captured").mkdir()
            for row in rows:
                if row["pipeline"] != "browser":
                    continue
                n = int(row["uploadedDuration"] * 16000)
                wav = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36+n*2, b"WAVE", b"fmt ", 16,
                                  1, 1, 16000, 32000, 2, 16, b"data", n*2) + struct.pack("<h", 100)*n
                row["uploadedAudioSha256"] = sha(wav)
                (root / "captured" / f"{row['id']}.wav").write_bytes(wav)
            (root / "package-manifest.json").write_bytes(raw)
            for name, data in {
                "samples": samples, "complete": {"platform": "linux", "sources": 100, "attempts": 200, "model": "sensevoice-small-q8"},
                "environment": {"platform": "linux", "run": "1", "commit": "commit",
                                "model": "sensevoice-small-q8", "threads": 2, "manifestSha256": sha(raw), "identity": identity},
                "browser": {"browserName": "chromium", "version": "fixture", "sourceRate": 48000},
            }.items():
                (root / f"{name}.json").write_text(json.dumps(data))
            (root / "results.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
            with patch("voice_browser_evidence.PACKAGE_HASHES", {"linux": sha(raw)}):
                self.assertEqual(len(load_platform(root, "linux", "1", "commit")[1]), 200)
                with self.assertRaises(ValueError):
                    load_platform(root, "linux", "other", "commit")
                path = root / "captured/s099.wav"
                path.write_bytes(path.read_bytes()[:-1] + b"x")
                with self.assertRaisesRegex(ValueError, "checksum"):
                    load_platform(root, "linux", "1", "commit")


if __name__ == "__main__":
    unittest.main()
