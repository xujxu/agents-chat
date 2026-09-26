import unittest

from voice_server_profiles import PROFILES, select_probes, summarize_profile
from voice_accuracy_benchmark import command


def sample(identifier, category, duration):
    return {"id": identifier, "category": category, "duration": duration,
            "reference": "hello", "audio_sha256": identifier}


def corpus():
    return [sample(f"{category}-{i}", category, 3) for category in ("zh", "en", "mixed") for i in range(10)] + [
        sample(f"long-{category}-{i}", category, 20) for category in ("zh", "mixed") for i in range(6)]


class ServerProfileTests(unittest.TestCase):
    def test_probe_selection_is_fixed_and_covers_short_and_natural_long(self):
        selected = select_probes(corpus())
        self.assertEqual(len(selected), 24)
        self.assertEqual(selected, select_probes(list(reversed(corpus()))))
        self.assertEqual(sum(row["duration"] >= 15 for row in selected), 6)
        self.assertEqual(len({row["id"] for row in selected}), 24)

    def test_missing_stratum_and_duplicate_inputs_fail(self):
        for rows in (corpus()[:20], corpus() + [corpus()[0]]):
            with self.assertRaises(ValueError):
                select_probes(rows)

    def test_profiles_are_voice_budgets_not_host_sizes(self):
        self.assertEqual(PROFILES, {"cpu2-ram4": {"threads": 2, "memory_gib": 4},
                                    "cpu4-ram8": {"threads": 4, "memory_gib": 8}})
        args = command("funasr", {"id": "probe"}, threads=4)
        self.assertIn("--num-threads=4", args)
        self.assertIn("--num-threads=2", command("funasr", {"id": "probe"}))

    def test_native_sense_threads_are_explicit_not_upstream_default_eight(self):
        for threads in (2, 4):
            args = command("sense-gguf", {"id": "probe"}, threads=threads)
            self.assertEqual(args, ["sense-runtime/bin/llama-funasr-sensevoice",
                                   "-m", "model/sensevoice-small-q8.gguf",
                                   "-a", "accuracy-samples/probe.wav",
                                   "--threads", str(threads), "--backend", "cpu"])
        with self.assertRaises(ValueError):
            command("sense-gguf", {"id": "probe"}, threads=8)

    def test_failed_attempts_are_scored_and_not_success_latency(self):
        source = [sample("a", "en", 3), sample("b", "en", 3)]
        rows = [{**row, "text": "hello", "failure": None, "seconds": 2,
                 "peak_rss_kib": 1000, "variant": "candidate"} for row in source]
        rows[1].update(text=None, failure="timeout_120s", seconds=120, peak_rss_kib=None)
        report = summarize_profile(source, rows)
        self.assertEqual(report["delivered"], 1)
        self.assertEqual(report["groups"][0]["error_rate"], .5)
        self.assertEqual(report["groups"][0]["successful_p95_seconds"], 2)
        self.assertEqual(report["missing_peak_measurements"], 1)
        self.assertFalse(report["all_delivered"])

    def test_report_rejects_missing_duplicate_and_different_audio(self):
        source = [sample("a", "en", 3)]
        row = {**source[0], "text": "hello", "failure": None, "seconds": 2,
               "peak_rss_kib": 1000, "variant": "candidate"}
        for rows in ([], [row, row], [{**row, "audio_sha256": "changed"}]):
            with self.assertRaises(ValueError):
                summarize_profile(source, rows)

    def test_medium_inputs_remain_separate_from_short_latency(self):
        source = [sample("a", "en", 8)]
        row = {**source[0], "text": "hello", "failure": None, "seconds": 2,
               "peak_rss_kib": 1000, "variant": "candidate"}
        self.assertEqual(summarize_profile(source, [row])["groups"][0]["duration_band"], "medium")


if __name__ == "__main__":
    unittest.main()
