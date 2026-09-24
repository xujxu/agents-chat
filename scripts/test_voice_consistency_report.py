import base64
import copy
import hashlib
import unittest

from voice_consistency_report import platform_report, select_samples


class ConsistencyTests(unittest.TestCase):
    def fixture(self):
        manifest = [{
            "id": f"sample-{i:03}", "dataset": "ASCEND" if i < 60 else "AISHELL-4",
            "category": "mixed" if i < 8 else ("en" if i < 30 else "zh" if i < 80 else "mixed"),
            "duration": 8 if i < 8 else 3 if i < 60 else 20, "split": "test",
            "audio_sha256": f"{i:064x}", "reference": "hello",
        } for i in range(100)]
        selected = select_samples(manifest)
        identity = {"manifest": "a" * 64, "binary": "b" * 64, "model": "c" * 64, "helper": None}
        rows = [{**row, "platform": "linux", "threads": threads, "repetition": rep,
                 "surface": surface, "identity": identity.copy(), "text": "hello",
                 "failure": None, "seconds": .1, "status": 200 if surface == "api" else None,
                 "apiElapsedMs": 90 if surface == "api" else None,
                 "stdoutBase64": base64.b64encode(b"hello\n").decode() if surface == "native" else None,
                 "stdoutSha256": hashlib.sha256(b"hello\n").hexdigest() if surface == "native" else None}
                for threads in (2, 1, 4) for rep in (1, 2, 3)
                for row in selected for surface in ("native", "transcriber", "api")]
        return manifest, selected, identity, rows

    def test_selection_is_fixed_and_order_independent(self):
        manifest, selected, _, _ = self.fixture()
        self.assertEqual(len(selected), 12)
        self.assertEqual(selected, select_samples(list(reversed(manifest))))
        self.assertTrue({f"sample-{i:03}" for i in range(8)} <= {r["id"] for r in selected})
        for kind in ("duplicate", "target_count", "control", "dataset"):
            changed = copy.deepcopy(manifest)
            if kind == "duplicate":
                changed[-1] = changed[0]
            elif kind == "target_count":
                changed[0]["duration"] = 3
            elif kind == "control":
                for row in changed:
                    if row["category"] == "en":
                        row["category"] = "zh"
            else:
                changed[0]["dataset"] = "other"
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                select_samples(changed)

    def test_complete_consistent_matrix(self):
        _, selected, identity, rows = self.fixture()
        result = platform_report(selected, rows, identity)
        self.assertEqual((result["attempts"], result["delivered"]), (324, 324))
        self.assertEqual(result["failures"], [])
        for name in ("repeatability", "layers", "threads"):
            self.assertTrue(result[name])
            self.assertTrue(all(row["equal"] is True for row in result[name]))

    def test_invalid_evidence_is_rejected(self):
        _, selected, identity, rows = self.fixture()
        for kind in ("missing", "duplicate", "hash", "package", "nan", "negative",
                     "stdout", "stdout_hash", "empty", "platform", "api_timing"):
            changed = copy.deepcopy(rows)
            if kind == "missing":
                changed.pop()
            elif kind == "duplicate":
                changed[-1] = changed[0]
            elif kind == "hash":
                changed[0]["audio_sha256"] = "bad"
            elif kind == "package":
                changed[0]["identity"]["binary"] = "d" * 64
            elif kind in ("nan", "negative"):
                changed[0]["seconds"] = float("nan") if kind == "nan" else -1
            elif kind == "stdout":
                changed[0]["stdoutBase64"] = "!"
            elif kind == "stdout_hash":
                changed[0]["stdoutSha256"] = "d" * 64
            elif kind == "empty":
                changed[1]["text"] = " "
            elif kind == "platform":
                changed[0]["platform"] = "win32"
            else:
                changed[2]["apiElapsedMs"] = True
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                platform_report(selected, changed, identity)

    def test_instability_and_failed_comparisons_are_explicit(self):
        _, selected, identity, rows = self.fixture()
        rows[1]["text"] = "different"
        result = platform_report(selected, rows, identity)
        self.assertTrue(any(row["equal"] is False for row in result["repeatability"]))
        self.assertTrue(any(row["equal"] is False for row in result["layers"]))
        for row in rows:
            row.update(text=None, failure="voice_timeout", stdoutBase64=None,
                       stdoutSha256=None, status=504 if row["surface"] == "api" else None,
                       apiElapsedMs=None)
        result = platform_report(selected, rows, identity)
        self.assertEqual(result["delivered"], 0)
        self.assertEqual(len(result["failures"]), 324)
        for name in ("repeatability", "layers", "threads"):
            self.assertTrue(all(row["equal"] is None for row in result[name]))


if __name__ == "__main__":
    unittest.main()
