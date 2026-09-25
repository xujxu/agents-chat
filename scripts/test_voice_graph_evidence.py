import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np

from voice_graph_evidence import expected_ids, read_array, unique_attempts


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


if __name__ == "__main__":
    unittest.main()
