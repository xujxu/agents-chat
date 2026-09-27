import unittest

from voice_model_stability import compare_repetitions


class StabilityTests(unittest.TestCase):
    def evidence(self):
        samples = [{"id": "a", "reference": "hello", "category": "en",
                    "duration": 2, "audio_sha256": "audio"}]
        rows = [{**samples[0], "profile": profile, "repeat": repeat,
                 "variant": "qwen-int8", "text": "hello", "failure": None}
                for profile in ("cpu2-ram4", "cpu4-ram8") for repeat in range(3)]
        return samples, rows

    def test_complete_unchanged_outputs_are_stable(self):
        samples, rows = self.evidence()
        result = compare_repetitions(samples, rows)
        self.assertTrue(result["stable_on_this_host"])
        self.assertEqual(result["attempts"], 6)

    def test_within_profile_and_cross_profile_differences_remain_visible(self):
        samples, rows = self.evidence()
        rows[0]["text"] = "hola"
        result = compare_repetitions(samples, rows)
        self.assertFalse(result["stable_on_this_host"])
        self.assertEqual(result["within_profile_changes"]["cpu2-ram4"], ["a"])
        self.assertEqual(result["cross_profile_changes"], ["a"])

    def test_failure_is_not_stable_even_when_every_attempt_fails(self):
        samples, rows = self.evidence()
        for row in rows:
            row.update(text=None, failure="timeout_120s")
        result = compare_repetitions(samples, rows)
        self.assertFalse(result["stable_on_this_host"])
        self.assertEqual(result["failures"], 6)
        self.assertTrue(all(group["wer"] == 1 for group in result["scores"]))

    def test_partial_duplicate_wrong_model_or_changed_audio_fail_closed(self):
        samples, rows = self.evidence()
        cases = [rows[:-1], rows + [rows[0]],
                 [{**rows[0], "audio_sha256": "changed"}, *rows[1:]],
                 [{**rows[0], "variant": "other"}, *rows[1:]]]
        for items in cases:
            with self.assertRaises(ValueError):
                compare_repetitions(samples, items)


if __name__ == "__main__":
    unittest.main()
