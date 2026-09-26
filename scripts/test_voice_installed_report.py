import copy
import unittest

from voice_installed_report import installed_report


class InstalledReportTests(unittest.TestCase):
    def fixture(self):
        manifest = [
            {"id": f"sample-{i}", "dataset": "ASCEND" if i < 60 else "AISHELL-4",
             "category": ["zh", "en", "mixed"][i % 3], "duration": 3 if i < 60 else 20,
             "split": "test", "audio_sha256": f"{i:064x}", "reference": "hello"}
            for i in range(100)
        ]
        baseline = [{**row, "variant": "sense", "text": "hello", "failure": None, "seconds": 1} for row in manifest]
        attempts = [{**row, "variant": "sensevoice-small-q8", "text": "hello", "failure": None, "seconds": 1} for row in manifest]
        return manifest, attempts, baseline

    def test_exact_delivery_passes_and_failures_count_as_deletions(self):
        manifest, attempts, baseline = self.fixture()
        self.assertTrue(installed_report(manifest, attempts, baseline)["candidates"][0]["eligible"])
        attempts[0].update(failure="voice_timeout", text=None)
        result = installed_report(manifest, attempts, baseline)["candidates"][0]
        self.assertIn("delivery_below_100_percent", result["violations"])
        self.assertTrue(any(row["error_rate"] > 0 for row in result["metrics"]))

    def test_empty_success_is_not_delivery(self):
        manifest, attempts, baseline = self.fixture()
        attempts[0]["text"] = " "
        result = installed_report(manifest, attempts, baseline)
        self.assertIn("delivery_below_100_percent", result["candidates"][0]["violations"])

    def test_processing_timing_is_separate_and_excludes_failures(self):
        manifest, attempts, baseline = self.fixture()
        for row in attempts:
            row["apiElapsedMs"] = 250
        attempts[0].update(failure="voice_failed", text=None, apiElapsedMs=100000)
        result = installed_report(manifest, attempts, baseline)
        self.assertEqual(result["delivered"], 99)
        self.assertEqual(result["api_success_timing"], [
            {"duration_band": "short", "measured_successes": 59, "p95_seconds": .25},
            {"duration_band": "medium", "measured_successes": 0, "p95_seconds": None},
            {"duration_band": "long", "measured_successes": 40, "p95_seconds": .25},
        ])
        self.assertEqual(result["candidates"][0]["p95_seconds"], 1)
        for value in (True, -1, float("nan"), float("inf"), "250"):
            attempts[1]["apiElapsedMs"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                installed_report(manifest, attempts, baseline)

    def test_incomplete_changed_duplicate_or_nonfinite_is_rejected(self):
        manifest, attempts, baseline = self.fixture()
        for change in ("missing", "duplicate", "reference", "dataset", "nan", "negative", "baseline"):
            rows, prior = copy.deepcopy(attempts), copy.deepcopy(baseline)
            if change == "missing":
                rows.pop()
            elif change == "duplicate":
                rows[-1] = rows[0]
            elif change in ("reference", "dataset"):
                rows[0][change] = "different"
            elif change == "baseline":
                prior[0]["audio_sha256"] = "bad"
            else:
                rows[0]["seconds"] = float("nan") if change == "nan" else -1
            with self.subTest(change=change), self.assertRaises(ValueError):
                installed_report(manifest, rows, prior)

    def test_original_latency_and_quality_thresholds_are_enforced(self):
        manifest, attempts, baseline = self.fixture()
        for row in attempts:
            row["seconds"] = 3.01 if row["duration"] <= 5 else 5.01
            row["text"] = "wrong"
        result = installed_report(manifest, attempts, baseline)["candidates"][0]
        self.assertIn("latency:short", result["violations"])
        self.assertIn("latency:long", result["violations"])
        self.assertTrue(any(value.startswith("quality:") for value in result["violations"]))


if __name__ == "__main__":
    unittest.main()
