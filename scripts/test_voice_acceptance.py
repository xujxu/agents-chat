import unittest

from voice_error_audit import audit_pairs
from voice_meeting_samples import choose_windows, continuous_windows


def interval(start, end, text, speaker="a"):
    return {"start": start, "end": end, "text": text, "speaker": speaker}


class ErrorAuditTests(unittest.TestCase):
    def test_pairs_cover_all_samples_and_separate_review_flags(self):
        rows = [
            {"id": "a", "variant": "sense", "reference": "你好 world", "text": "你好",
             "category": "mixed", "failure": None},
            {"id": "a", "variant": "safe-encoder", "reference": "你好 world", "text": "你好 world",
             "category": "mixed", "failure": None},
            {"id": "b", "variant": "sense", "reference": "世界", "text": "世界",
             "category": "zh", "failure": None},
            {"id": "b", "variant": "safe-encoder", "reference": "世界", "text": "世界",
             "category": "zh", "failure": None},
        ]
        summary, pairs = audit_pairs(rows)
        self.assertEqual(summary["paired_samples"], 2)
        self.assertEqual(summary["wins"]["safe-encoder"], 1)
        self.assertEqual(summary["wins"]["tie"], 1)
        self.assertIn("english_span_error", pairs[0]["flags"])
        self.assertEqual(pairs[0]["review_status"], "not_manually_verified")
        self.assertEqual(summary["normalization_changed_errors"]["sense"], 0)

    def test_missing_duplicate_and_changed_reference_fail(self):
        row = {"id": "a", "variant": "sense", "reference": "你好", "text": "",
               "category": "zh", "failure": None}
        for rows in ([row], [row, row], [row, {**row, "variant": "safe-encoder", "reference": "不同"}]):
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    audit_pairs(rows)

    def test_case_and_punctuation_are_not_claimed_as_model_errors(self):
        rows = [{"id": "a", "variant": variant, "reference": "Hello, world!",
                 "text": "hello world", "category": "en", "failure": None}
                for variant in ("sense", "safe-encoder")]
        summary, pairs = audit_pairs(rows)
        self.assertEqual(summary["wins"]["tie"], 1)
        self.assertEqual(pairs[0]["sense_errors"], 0)


class NaturalWindowTests(unittest.TestCase):
    def test_keeps_continuous_source_window_and_pause(self):
        rows = [interval(1, 9, "今天 discussing software"),
                interval(10, 18, "然后 finish the work")]
        windows = continuous_windows("meeting", rows)
        window = next(row for row in windows if row["start"] == 1 and row["end"] == 18)
        self.assertEqual(window["duration"], 17)
        self.assertEqual(window["voiced_seconds"], 16)
        self.assertEqual(window["category"], "mixed")
        self.assertEqual(window["reference"], "今天 discussing software 然后 finish the work")

    def test_never_drops_overlap_or_unknown_speech_from_reference(self):
        overlap = [interval(0, 20, "中文发言"), interval(5, 6, "other voice", "b")]
        self.assertEqual(continuous_windows("meeting", overlap), [])
        unknown = [interval(0, 8, "中文"), interval(8, 9, "<%>"), interval(9, 17, "hello")]
        self.assertEqual(continuous_windows("meeting", unknown), [])

    def test_rejects_duration_padding_and_sparse_speech(self):
        self.assertEqual(continuous_windows("m", [interval(0, 8, "短句")]), [])
        self.assertEqual(continuous_windows("m", [interval(0, 31, "太长")]), [])
        self.assertEqual(continuous_windows("m", [interval(0, 1, "短"), interval(20, 21, "句")]), [])

    def test_selection_is_stable_nonoverlapping_and_counts_shortfall(self):
        rows = continuous_windows("a", [interval(0, 16, "中文 hello"), interval(17, 34, "世界 hello")])
        selected = choose_windows(rows, 40)
        self.assertEqual(len(selected), 2)
        self.assertEqual(selected, choose_windows(list(reversed(rows)), 40))
        self.assertTrue(all(row["duration"] >= 15 for row in selected))


if __name__ == "__main__":
    unittest.main()
