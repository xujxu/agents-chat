import unittest

from voice_chain_report import combine_results, select_short


class ChainReportTests(unittest.TestCase):
    def test_short_selection_is_stable_and_stratified(self):
        rows = [{"id": f"{category}-{i}", "category": category, "duration": 3}
                for category in ("zh", "en", "mixed") for i in range(30)]
        chosen = select_short(rows)
        self.assertEqual(len(chosen), 60)
        self.assertEqual(chosen, select_short(list(reversed(rows))))

    def test_rejects_missing_duplicate_or_unexpected_pipeline_results(self):
        sample = {"id": "one", "reference": "你好", "category": "zh", "duration": 2,
                  "dataset": "ASCEND", "audio_sha256": "a"}
        direct = {"id": "one", "pipeline": "direct-wav-api", "text": "你好",
                  "status": 200, "error": None, "seconds": 1}
        browser = {**direct, "pipeline": "browser-recorded-api"}
        summaries, scored = combine_results([sample], [direct, browser])
        self.assertEqual(len(summaries), 2)
        self.assertEqual(sum(row["delivered_score"]["errors"] for row in scored), 0)
        for rows in ([direct], [direct, browser, direct], [direct, {**browser, "id": "wrong"}]):
            with self.assertRaises(ValueError):
                combine_results([sample], rows)

    def test_service_memory_failure_is_not_a_successful_transcript(self):
        sample = {"id": "one", "reference": "你好", "category": "zh", "duration": 2,
                  "dataset": "ASCEND", "audio_sha256": "a"}
        rows = [{"id": "one", "pipeline": pipeline, "status": 503, "error": "voice_memory_limit",
                 "text": None, "seconds": 1} for pipeline in ("direct-wav-api", "browser-recorded-api")]
        summaries, scored = combine_results([sample], rows)
        self.assertTrue(all(row["error_rate"] == 1 for row in summaries))
        self.assertTrue(all(row["failures"] == 1 for row in summaries))


if __name__ == "__main__":
    unittest.main()
