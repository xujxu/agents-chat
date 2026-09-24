import unittest

from voice_choice import choose_development, decide


def row(identifier, variant, errors=0, duration=3, category="mixed", seconds=1, failure=None):
    return {"id": identifier, "variant": variant, "category": category, "duration": duration,
            "seconds": seconds, "failure": failure, "text": "hello", "reference": "你好 hello",
            "audio_sha256": identifier, "peak_rss_kib": 300000,
            "score": {"reference_tokens": 100, "errors": errors}}


class ChoiceTests(unittest.TestCase):
    def test_dev_selects_only_successful_configuration_without_test_rows(self):
        rows = [dict(row("dev-1", name, errors=errors), split="validation")
                for name, errors in (("segment-2", 10), ("segment-3", 8), ("segment-5", 5))]
        rows[-1]["failure"] = "voice_memory_limit"
        self.assertEqual(choose_development(rows)["variant"], "segment-3")
        rows.append(dict(row("test-1", "segment-3"), split="test"))
        with self.assertRaises(ValueError):
            choose_development(rows)

    def test_none_eligible_is_not_a_winner(self):
        baseline = [row("a", "sense", 10)]
        candidates = [row("a", "whisper", 10, failure="voice_memory_limit")]
        report = decide(candidates, baseline)
        self.assertIsNone(report["winner"])
        self.assertFalse(report["candidates"][0]["eligible"])

    def test_latency_and_two_percentage_point_quality_gate(self):
        baseline = [row("a", "sense", 10)]
        for errors, seconds in ((13, 1), (10, 3.01)):
            report = decide([row("a", "segment-3", errors, seconds=seconds)], baseline)
            self.assertIsNone(report["winner"])
        self.assertEqual(decide([row("a", "segment-3", 12, seconds=3)], baseline)["winner"], "segment-3")

    def test_missing_or_duplicate_rows_fail_closed(self):
        baseline = [row("a", "sense"), row("b", "sense")]
        for candidates in ([row("a", "x")], [row("a", "x"), row("a", "x")]):
            with self.assertRaises(ValueError):
                decide(candidates, baseline)

    def test_near_tie_prefers_faster_candidate_and_long_uses_five_seconds(self):
        baseline = [row("a", "sense", 20, duration=20)]
        candidates = [row("a", "x", 10, duration=20, seconds=4),
                      row("a", "y", 10, duration=20, seconds=2)]
        self.assertEqual(decide(candidates, baseline)["winner"], "y")
        self.assertIsNone(decide([row("a", "x", 10, duration=20, seconds=5.01)], baseline)["winner"])


if __name__ == "__main__":
    unittest.main()
