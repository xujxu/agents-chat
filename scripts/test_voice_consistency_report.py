import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from voice_consistency_report import aggregate, platform_report, select_samples


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

    def test_aggregate_keeps_stable_differences_and_checks_history(self):
        manifest, selected, identity, rows = self.fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for platform in ("linux", "win32"):
                package = {"files": [
                    {"role": role, "sha256": digest} for role, digest in identity.items()
                    if role in ("binary", "model")
                ] + ([{"role": "helper", "sha256": "d" * 64}] if platform == "win32" else [])}
                package_bytes = json.dumps(package).encode()
                current_identity = {**identity, "manifest": hashlib.sha256(package_bytes).hexdigest(),
                                    "helper": "d" * 64 if platform == "win32" else None}
                current = copy.deepcopy(rows)
                for row in current:
                    row.update(platform=platform, identity=current_identity)
                    if platform == "win32" and row["surface"] == "transcriber" and row["id"] == selected[0]["id"]:
                        row["text"] = "different"
                folder = root / platform
                folder.mkdir()
                (folder / "samples.json").write_text(json.dumps(selected))
                (folder / "environment.json").write_text(json.dumps({"platform": platform, "identity": current_identity}))
                (folder / "package-manifest.json").write_bytes(package_bytes)
                for thread in (2, 1, 4):
                    (folder / f"attempts-{thread}.jsonl").write_text("\n".join(
                        json.dumps(row) for row in current if row["threads"] == thread))
                    (folder / f"complete-{thread}.json").write_text(json.dumps({"threads": thread, "count": 108}))
                prior = root / f"prior-{platform}" / "installed-evidence"
                prior.mkdir(parents=True)
                (prior / "environment.json").write_text(json.dumps({
                    "manifestSha256": current_identity["manifest"], "platform": platform}))
                (prior / "package-manifest.json").write_bytes(package_bytes)
                (prior / "complete.json").write_text(json.dumps({"count": 100, "variant": "sensevoice-small-q8"}))
                (prior / "results.jsonl").write_text("\n".join(json.dumps({
                    **row, "variant": "sensevoice-small-q8", "text": "hello", "failure": None,
                }) for row in manifest))
            args = [root / name for name in ("linux", "win32", "prior-linux", "prior-win32", "report")]
            self.assertEqual(aggregate(*args), 0)
            report = json.loads((root / "report/summary.json").read_text())
            self.assertEqual(sum(row["equal"] is False for row in report["cross_platform"]), 9)
            self.assertTrue(all(row["equal"] is True for row in report["platforms"]["win32"]["repeatability"]))
            file = root / "linux/attempts-2.jsonl"
            changed = [json.loads(line) for line in file.read_text().splitlines()]
            changed[1].update(failure="voice_timeout", text=None)
            file.write_text("\n".join(map(json.dumps, changed)))
            self.assertEqual(aggregate(*args), 1)
            prior = root / "prior-linux/installed-evidence/environment.json"
            prior.write_text(json.dumps({"manifestSha256": "0" * 64, "platform": "linux"}))
            with self.assertRaises(ValueError):
                aggregate(*args)
            (root / "linux/complete-2.json").unlink()
            with self.assertRaises(FileNotFoundError):
                aggregate(*args)


if __name__ == "__main__":
    unittest.main()
