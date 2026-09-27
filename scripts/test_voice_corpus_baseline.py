from pathlib import Path
import re
import unittest

from voice_corpus_data import select_rows
from voice_corpus_report import evaluate, summarize, validate_results


def sample(identifier="test-1", reference="你好 world", category="mixed"):
    return {
        "id": identifier, "reference": reference, "category": category,
        "split": "test", "duration": 2.0, "audio_sha256": "a" * 64,
    }


def result(item=None, **changes):
    row = {
        **(item or sample()), "variant": "sense", "text": "你好 world",
        "failure": None, "seconds": 1.0, "peak_rss_kib": 1024,
    }
    row.update(changes)
    return row


class CorpusSelectionTests(unittest.TestCase):
    def test_workflow_checksums_are_well_formed_and_match_existing_models(self):
        workflows = Path(__file__).resolve().parents[1] / ".github" / "workflows"
        baseline = (workflows / "voice-corpus-baseline.yml").read_text()
        existing = (workflows / "voice-natural-long.yml").read_text()
        checks = re.findall(r"echo '([^']+)' \| sha256sum --check", baseline)
        self.assertEqual(len(checks), 5)
        for check in checks:
            self.assertRegex(check, r"^[0-9a-f]{64}  \S+$")
            self.assertIn(check, existing)

    def test_all_rows_accounted_for_without_model_conditioned_sampling(self):
        rows = [
            {"id": "1", "transcription": "你好 world", "duration": 2},
            {"id": "2", "transcription": "纯中文", "duration": 3},
            {"id": "3", "transcription": "Hello world", "duration": 4},
            {"id": "4", "transcription": "hello [UNK]", "duration": 3},
            {"id": "5", "transcription": "...", "duration": 3},
            {"id": "6", "transcription": "你好", "duration": 31},
            {"id": "7", "transcription": "你好", "duration": 0},
            {"id": "8", "transcription": "你好", "duration": float("nan")},
        ]
        selected, inventory = select_rows(rows)
        self.assertEqual([r["id"] for r in selected], ["test-1", "test-2", "test-3"])
        self.assertEqual([r["category"] for r in selected], ["mixed", "zh", "en"])
        self.assertEqual(len(inventory), 8)
        self.assertEqual(sum(r["included"] for r in inventory), 3)
        self.assertTrue(all(r["reason"] for r in inventory if not r["included"]))
        self.assertTrue(all(r["split"] == "test" for r in selected))

    def test_duplicate_and_unsafe_identifiers_are_errors(self):
        for ids in (["1", "1"], ["../1", "2"]):
            with self.subTest(ids=ids):
                rows = [{"id": i, "transcription": "你好", "duration": 2} for i in ids]
                with self.assertRaises(ValueError):
                    select_rows(rows)


class CorpusScoringTests(unittest.TestCase):
    def test_cer_wer_and_mer_have_explicit_units(self):
        chinese = evaluate(result(sample(reference="你好12", category="zh"), text="你好"))
        self.assertEqual(chinese["metric"], "CER")
        self.assertEqual(chinese["delivered_score"]["reference_tokens"], 4)
        self.assertEqual(chinese["delivered_score"]["deletions"], 2)
        english = evaluate(result(sample(reference="hello world", category="en"), text="hello"))
        self.assertEqual(english["metric"], "WER")
        self.assertEqual(english["delivered_score"]["mer"], 0.5)
        mixed = evaluate(result(text="你好"))
        self.assertEqual(mixed["metric"], "MER")
        self.assertEqual(mixed["delivered_score"]["reference_tokens"], 3)

    def test_failed_output_is_not_silently_dropped_or_accepted(self):
        row = evaluate(result(failure="context_truncation", text="你好 world"))
        self.assertEqual(row["text"], "你好 world")
        self.assertEqual(row["delivered_score"]["mer"], 1)
        self.assertIsNone(row["successful_score"])
        self.assertEqual(row["raw_score"]["mer"], 0)

    def test_empty_success_is_explicit_and_counts_as_deletions(self):
        row = evaluate(result(text=""))
        self.assertEqual(row["delivered_score"]["mer"], 1)
        summary = summarize([row])[0]
        self.assertEqual(summary["empty_outputs"], 1)
        self.assertEqual(summary["samples"], 1)

    def test_micro_average_includes_failure_and_can_exceed_one(self):
        rows = [
            evaluate(result(sample("test-1", "你", "zh"), text="你好世界")),
            evaluate(result(sample("test-2", "你好啊", "zh"), text=None, failure="timeout_120s")),
        ]
        summary = summarize(rows)[0]
        self.assertEqual(summary["reference_units"], 4)
        self.assertEqual(summary["errors"], 6)
        self.assertEqual(summary["error_rate"], 1.5)
        self.assertEqual(summary["failures"], 1)
        self.assertEqual(summary["successful_samples"], 1)
        self.assertEqual(summary["successful_error_rate"], 3)

    def test_incomplete_peak_memory_is_not_reported_as_zero(self):
        row = evaluate(result(failure="missing_peak_memory", peak_rss_kib=None))
        self.assertIsNone(summarize([row])[0]["max_rss_mib"])

    def test_partition_and_variant_groups_remain_separate(self):
        rows = [
            evaluate(result()),
            evaluate(result(variant="safe-encoder", failure="exit_1")),
            evaluate(result(sample("test-2", "hello", "en"), text="hello")),
        ]
        self.assertEqual(len(summarize(rows)), 3)

    def test_rejects_missing_duplicate_or_mismatched_results(self):
        manifest = [sample()]
        good = [result()]
        validate_results(manifest, good, ["sense"])
        bad_sets = [
            [], good + good, [result(audio_sha256="b" * 64)],
            [result(reference="changed")], [result(category="en")],
            [result(variant="unknown")], [result(identifier="unused", id="test-other")],
        ]
        for rows in bad_sets:
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    validate_results(manifest, rows, ["sense"])


if __name__ == "__main__":
    unittest.main()
