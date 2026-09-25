import hashlib
import copy
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from voice_graph_evidence import expected_ids, load_attempt, read_array, read_wav, unique_attempts
from voice_graph_report import difference


def fixture(root):
    values = np.zeros(128000, dtype="<f4")
    def save(name, data, **extra):
        (root / name).write_bytes(data)
        return {"file": name, "sha256": hashlib.sha256(data).hexdigest(), **extra}
    count = len(values)
    wav = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36+count*2, b"WAVE", b"fmt ", 16,
                      1, 1, 16000, 32000, 2, 16, b"data", count*2) + bytes(count*2)
    audio = save("test.wav", wav)
    data = save("samples.f32", values.tobytes(), samples=count)
    lengths = [2048] * (count // 2048) + [count % 2048]
    kinds = ["worklet_created", "B_start", *["chunk"] * len(lengths), "finished", "D_start", "E_rendered"]
    row = {
        "id": "desktop-chromium/mono-tones/0/full", "project": "desktop-chromium",
        "stimulus": "mono-tones", "repeat": 0, "mode": "full", "run": "1", "commit": "abc",
        "error": None, "A": audio, "F": audio, "received": audio,
        "receiver": {"requests": 1, "error": None},
        "snapshot": {"observerError": None, "fetchFailure": None, "status": 200,
                     "composerText": "Synthetic graph fixture; no ASR",
                     "capture": {"sourceCompleted": True, "tracksStopped": True, "contextClosed": True,
                                 "sourceRate": 16000, "recorderRate": 16000},
                     "timing": {"stopKind": "manual", "stopAt": 1, "workletStopAt": 2,
                                "fetchAt": 3, "bodyAt": 4, "composerAt": 5}},
        "probe": {"errors": [], "terminals": ["finished"], "recorderClosed": True,
                  "tracks": [{"id": "fixture"}], "chunkLengths": lengths,
                  "events": [{"kind": kind, "at": index} for index, kind in enumerate(kinds)]},
    }
    row.update({name: {"rate": 16000, "channels": [data]} for name in "BCDE"})
    return row


class GraphEvidenceTests(unittest.TestCase):
    def test_exact_schedule(self):
        ids = expected_ids()
        self.assertEqual(len(ids), 36)
        rows = [{"id": value} for value in ids]
        self.assertEqual(len(unique_attempts(rows)), 36)
        for bad in [rows[:-1], rows + rows[:1], rows + [{"id": "unknown"}]]:
            with self.assertRaises(ValueError):
                unique_attempts(bad)

    def test_array_identity_and_shape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = np.array([.1, .2], dtype="<f4").tobytes()
            (root / "pcm.f32").write_bytes(data)
            item = {"file": "pcm.f32", "sha256": hashlib.sha256(data).hexdigest(), "samples": 2}
            self.assertEqual(len(read_array(root, item)), 2)
            for changed in [{"file": "../pcm.f32"}, {"sha256": "0" * 64}, {"samples": 3}]:
                with self.assertRaises(ValueError):
                    read_array(root, {**item, **changed})
            invalid = np.array([np.nan], dtype="<f4").tobytes()
            (root / "nan.f32").write_bytes(invalid)
            with self.assertRaises(ValueError):
                read_array(root, {"file": "nan.f32", "samples": 1,
                                 "sha256": hashlib.sha256(invalid).hexdigest()})

    @patch.dict(os.environ, {"GITHUB_RUN_ID": "1", "GITHUB_SHA": "abc"})
    def test_required_boundaries_and_historical_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            row = fixture(root)
            stages, pcm = load_attempt(root, row)
            self.assertEqual(set(stages), set("ABCDEF"))
            self.assertEqual(len(pcm), 128000)
            for mutate in [
                lambda r: r.update(commit="stale"),
                lambda r: r.update(run="stale"),
                lambda r: r.update(error="capture_failed"),
                lambda r: r["probe"]["errors"].append("hook_failed"),
                lambda r: r["probe"].update(terminals=["limit"]),
                lambda r: r["D"].update(rate=48000),
                lambda r: r["probe"].update(chunkLengths=[128000]),
                lambda r: r["probe"].update(events=[]),
                lambda r: r["receiver"].update(requests=2),
                lambda r: r["snapshot"]["capture"].update(contextClosed=False),
            ]:
                broken = copy.deepcopy(row)
                mutate(broken)
                with self.assertRaises(ValueError):
                    load_attempt(root, broken)
            missing = copy.deepcopy(row)
            del missing["D"]
            with self.assertRaises(KeyError):
                load_attempt(root, missing)
            minimal = copy.deepcopy(row)
            minimal.update(id="desktop-chromium/mono-tones/0/minimal", mode="minimal", probe=None)
            for name in "BCDE":
                del minimal[name]
            self.assertEqual(set(load_attempt(root, minimal)[0]), {"A", "F"})
            minimal["B"] = row["B"]
            with self.assertRaises(ValueError):
                load_attempt(root, minimal)

    def test_exact_comparison_and_wav_headers(self):
        self.assertTrue(difference(np.array([1, 2]), np.array([1, 2]))["equal"])
        result = difference(np.array([1, 2, 3]), np.array([1, 4]))
        self.assertEqual(result["first_different"], 1)
        self.assertEqual(result["differing_samples"], 2)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            row = fixture(root)
            data = bytearray((root / "test.wav").read_bytes())
            data[28:32] = bytes(4)
            (root / "invalid.wav").write_bytes(data)
            with self.assertRaises(ValueError):
                read_wav(root, {"file": "invalid.wav", "sha256": hashlib.sha256(data).hexdigest()})


if __name__ == "__main__":
    unittest.main()
