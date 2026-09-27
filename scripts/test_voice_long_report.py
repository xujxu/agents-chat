import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from voice_accuracy_benchmark import trial
from voice_long_report import inspect_log, nearest_rank, repeated_output


class ReportTests(unittest.TestCase):
    def test_percentile_is_explicit_nearest_rank(self):
        self.assertEqual(nearest_rank(list(range(1, 41)), .95), 38)

    def test_missing_timing_is_not_zero(self):
        result = inspect_log("unrelated diagnostic")
        self.assertIsNone(result["init_seconds"])
        self.assertIsNone(result["decode_seconds"])

    def test_context_warning_survives_successful_exit(self):
        log = ("recognizer created in 6.020 s\nElapsed seconds: 5.727 s\n"
               "Context_len (519) exceeds KV capacity (512). Truncating audio placeholders: "
               "audio_token_len=496 -> keep_audio=489 (before=18 after=5).\n")
        result = inspect_log(log)
        self.assertEqual(result["init_seconds"], 6.02)
        self.assertEqual(result["decode_seconds"], 5.727)
        self.assertEqual(len(result["context_truncation_warnings"]), 1)

    def test_repetition_is_only_a_review_flag(self):
        self.assertTrue(repeated_output("你好世界" * 5))
        self.assertFalse(repeated_output("我们今天 I want to swim 然后去吃饭"))
        self.assertFalse(repeated_output(""))

    def test_trial_never_scores_unverified_reference_and_flags_truncation(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            os.chdir(directory)
            try:
                Path("artifacts").mkdir()
                def launch(args, stdout, stderr, **kwargs):
                    stdout.write('{"text": "", "tokens": []}\n')
                    stderr.write("Truncating audio placeholders: audio_token_len=496 -> keep_audio=489\n")
                    Path(args[4]).write_text("1024\n")
                    class Process:
                        def wait(self, timeout):
                            return 0
                    return Process()
                with patch("voice_accuracy_benchmark.subprocess.Popen", side_effect=launch), \
                        patch("voice_accuracy_benchmark.score") as scorer:
                    result = trial("funasr", {"id": "test", "duration": 30}, score_reference=False)
                    scorer.assert_not_called()
                    self.assertIsNone(result["score"])
                    self.assertEqual(result["failure"], "context_truncation")
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
