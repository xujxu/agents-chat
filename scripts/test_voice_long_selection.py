import unittest

from voice_long_selection import describe, select


def sample(identifier, duration=20, split="test", text="今天 I want to go swimming 然后回家"):
    return {"id": identifier, "duration": duration, "split": split, "transcription": text}


class LongSelectionTests(unittest.TestCase):
    def test_exact_duration_boundaries(self):
        for duration in (15, 30):
            self.assertIsNotNone(describe(sample("a", duration)))
        for duration in (14.999, 30.001, 0):
            self.assertIsNone(describe(sample("a", duration)))

    def test_reject_incomplete_or_monolingual_reference(self):
        for text in ("你好世界", "hello world", "今天 [UNK] go home", "今天 <noise> go home"):
            self.assertIsNone(describe(sample("a", text=text)))

    def test_english_runs_are_not_claimed_to_be_sentences(self):
        result = describe(sample("a"))
        self.assertEqual(result["english_words"], 5)
        self.assertEqual(result["longest_english_run"], 5)
        self.assertEqual(result["switches"], 2)

    def test_prefer_official_evaluation_splits_and_never_pad(self):
        rows = [sample("train", split="train"), sample("val", split="validation"), sample("test")]
        self.assertEqual([r["id"] for r in select(rows, 2)], ["test", "val"])
        self.assertEqual(len(select(rows, 40)), 3)
        self.assertEqual(select(rows, 40), select(list(reversed(rows)), 40))

    def test_short_audio_never_fills_long_quota(self):
        self.assertEqual(select([sample("short", 12)], 40), [])


if __name__ == "__main__":
    unittest.main()
