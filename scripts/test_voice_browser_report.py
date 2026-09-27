import copy
import hashlib
import unittest

from voice_browser_report import browser_report


def fixture():
    samples = [{
        "id": f"s{i:03d}", "reference": "你好 world", "category":
        ("zh", "en", "mixed")[i % 3] if i < 60 else ("zh", "mixed")[i % 2],
        "duration": 2.0 if i < 50 else 8.0 if i < 60 else 20.0,
        "dataset": "ASCEND" if i < 60 else "AISHELL-4", "split": "test",
        "audio_sha256": hashlib.sha256(str(i).encode()).hexdigest(),
    } for i in range(100)]
    original = [{**s, "text": s["reference"], "failure": None} for s in samples]
    rows, baseline = [], []
    for platform in ("linux", "win32"):
        for sample in samples:
            for pipeline in ("direct", "browser"):
                browser = pipeline == "browser"
                uploaded_hash = (hashlib.sha256((platform + sample["id"]).encode()).hexdigest()
                                 if browser else sample["audio_sha256"])
                rows.append({
                    **sample, "platform": platform, "pipeline": pipeline,
                    "text": sample["reference"], "apiText": sample["reference"],
                    "failure": None, "seconds": 1.0, "status": 200, "apiElapsedMs": 500.0,
                    "uploadedAudioSha256": uploaded_hash,
                    "uploadedDuration": sample["duration"] + .1 if browser else sample["duration"],
                    "timing": {"stopAt": 1000.0, "workletStopAt": 1001.0, "fetchAt": 1200.0,
                               "bodyAt": 1800.0, "composerAt": 2000.0, "terminalAt": 2000.0,
                               "stopKind": "manual"} if browser else None,
                    "capture": {"sourceRate": 48000, "recorderRate": 48000,
                                "sourceCompleted": True} if browser else None,
                })
                if browser:
                    baseline.append({"platform": platform, "id": sample["id"],
                                     "uploadedAudioSha256": uploaded_hash, "text": sample["reference"],
                                     "failure": None, "seconds": 1.0, "unavailable": False})
    return samples, rows, original, baseline


class BrowserReportTests(unittest.TestCase):
    def test_complete_primary_and_identical_byte_diagnostics(self):
        report = browser_report(*fixture())
        self.assertEqual(report["attempts"], 400)
        self.assertEqual(len(report["cells"]), 4)
        self.assertTrue(report["primary_pass"])
        self.assertFalse(report["release_approved"])
        for cell in report["cells"]:
            self.assertEqual(cell["delivered"], 100)
            self.assertEqual(len(cell["quality"]), 8)
        self.assertEqual(report["diagnostics"]["available"], 200)

    def test_invalid_coverage_identity_timing_and_success(self):
        for kind in ("missing", "duplicate", "unexpected", "identity", "nan", "negative",
                     "empty", "hash", "baseline-hash", "success-ui", "success-capture"):
            samples, rows, original, baseline = fixture()
            if kind == "missing":
                rows.pop()
            elif kind == "duplicate":
                rows[-1] = rows[0]
            elif kind == "unexpected":
                rows[0]["pipeline"] = "unknown"
            elif kind == "identity":
                rows[0]["reference"] = "changed"
            elif kind == "nan":
                rows[0]["seconds"] = float("nan")
            elif kind == "negative":
                rows[1]["timing"]["fetchAt"] = -1
            elif kind == "empty":
                rows[0]["text"] = ""
            elif kind == "hash":
                rows[1]["uploadedAudioSha256"] = "bad"
            elif kind == "baseline-hash":
                baseline[0]["uploadedAudioSha256"] = samples[0]["audio_sha256"]
            elif kind == "success-ui":
                rows[1]["text"] = "different"
            elif kind == "success-capture":
                rows[1]["capture"]["sourceCompleted"] = False
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                browser_report(samples, rows, original, baseline)

    def test_failures_are_deletions_and_missing_stop_never_becomes_zero(self):
        samples, rows, original, baseline = fixture()
        rows[1].update(failure="capture_failed", text=None, apiText=None, seconds=None, status=None,
                       apiElapsedMs=None, uploadedAudioSha256=None, uploadedDuration=None,
                       timing=None, capture=None)
        baseline[0].update(uploadedAudioSha256=None, text=None, failure="unavailable_input",
                           seconds=None, unavailable=True)
        report = browser_report(samples, rows, original, baseline)
        cell = next(c for c in report["cells"] if c["platform"] == "linux" and c["pipeline"] == "browser")
        self.assertFalse(report["primary_pass"])
        self.assertEqual(cell["delivered"], 99)
        short = next(g for g in cell["duration"] if g["band"] == "short")
        self.assertIsNone(short["p95_seconds"])
        self.assertEqual(short["unavailable"], 1)
        self.assertGreater(next(q for q in cell["quality"] if q["category"] == "zh"
                                and q["band"] == "short")["error_rate"], 0)
        self.assertEqual(report["diagnostics"]["unavailable"], 1)

    def test_ui_failure_retains_api_text_but_is_not_delivery(self):
        samples, rows, original, baseline = fixture()
        rows[1].update(failure="ui_not_filled", text=None, seconds=130)
        rows[1]["timing"].update(composerAt=None, terminalAt=131000)
        report = browser_report(samples, rows, original, baseline)
        self.assertFalse(report["primary_pass"])
        self.assertEqual(report["diagnostics"]["available"], 200)

    def test_original_duration_and_all_attempt_latency_control_gates(self):
        samples, rows, original, baseline = fixture()
        for row in rows:
            if row["platform"] == "linux" and row["pipeline"] == "browser" and row["duration"] == 2:
                row["uploadedDuration"] = 5.1
                row["seconds"] = 4
                row["timing"].update(composerAt=5000, terminalAt=5000)
        report = browser_report(samples, rows, original, baseline)
        cell = next(c for c in report["cells"] if c["platform"] == "linux" and c["pipeline"] == "browser")
        self.assertIn("latency:short", cell["violations"])
        self.assertEqual(next(d for d in cell["duration"] if d["band"] == "short")["samples"], 50)

    def test_captured_baseline_degradation_cannot_promote_primary_failure(self):
        samples, rows, original, baseline = fixture()
        for row in rows:
            if row["pipeline"] == "browser":
                row.update(text="wrong", apiText="wrong")
        for row in baseline:
            row["text"] = "wrong wrong wrong wrong"
        report = browser_report(samples, rows, original, baseline)
        self.assertFalse(report["primary_pass"])
        self.assertFalse(report["release_approved"])
        self.assertTrue(all(any(v.startswith("quality:") for v in c["violations"])
                            for c in report["cells"] if c["pipeline"] == "browser"))
        broken = copy.deepcopy(baseline)
        broken.pop()
        with self.assertRaises(ValueError):
            browser_report(samples, rows, original, broken)


if __name__ == "__main__":
    unittest.main()
