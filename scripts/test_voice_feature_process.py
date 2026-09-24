import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

from voice_feature_process import run_native


class ProcessTests(unittest.TestCase):
    def invoke(self, code, **kwargs):
        helper = os.environ.get("FEATURE_TEST_HELPER")
        if sys.platform == "win32" and not helper:
            self.fail("Windows lifecycle contracts require the verified installed helper")
        return run_native(sys.executable, ["-c", code], helper=helper, **kwargs)

    def test_strict_output_and_exit(self):
        result = self.invoke("import sys; sys.stdout.buffer.write('你好'.encode('utf-8'))")
        self.assertEqual(result["text"], "你好")
        self.assertIsNone(result["failure"])
        for code, failure in (
            ("pass", "voice_no_speech"),
            ("import sys; sys.stdout.buffer.write(b'\\xff')", "voice_invalid_result"),
            ("print('a\\0b')", "voice_invalid_result"),
            ("print('x'*32769)", "voice_invalid_result"),
            ("raise SystemExit(3)", "voice_inference_failed"),
            ("raise SystemExit(124)", "voice_inference_failed"),
        ):
            with self.subTest(code=code):
                result = self.invoke(code)
                self.assertEqual(result["failure"], failure)
                self.assertIsNone(result["text"])
        if sys.platform != "win32":
            self.assertEqual(self.invoke("import sys; sys.stderr.write('x'*65537); print('ok')")
                             ["failure"], "voice_process_failed")

    def test_timeout_and_cancellation(self):
        started = time.monotonic()
        self.assertEqual(self.invoke("import time; time.sleep(30)", timeout=.4)["failure"], "voice_timeout")
        self.assertLess(time.monotonic() - started, 8)
        cancel = threading.Event()
        timer = threading.Timer(.4, cancel.set)
        timer.start()
        try:
            self.assertEqual(self.invoke("import time; time.sleep(30)", cancel=cancel)
                             ["failure"], "voice_cancelled")
        finally:
            timer.join()

    def test_descendant_cleanup_on_success_timeout_and_overflow(self):
        with tempfile.TemporaryDirectory(prefix="feature-child-") as directory:
            for mode in ("success", "timeout", "overflow"):
                marker = Path(directory) / mode
                descendant = (
                    "import time; from pathlib import Path; "
                    f"time.sleep(2); Path({str(marker)!r}).write_text('leaked'); time.sleep(20)"
                )
                code = (
                    "import subprocess,sys,time; "
                    f"subprocess.Popen([sys.executable,'-c',{descendant!r}]); "
                    + ("print('ok')" if mode == "success" else
                       "time.sleep(30)" if mode == "timeout" else "print('x'*40000); time.sleep(30)")
                )
                result = self.invoke(code, timeout=1)
                self.assertEqual(result["failure"], {
                    "success": None, "timeout": "voice_timeout", "overflow": "voice_invalid_result"
                }[mode])
                time.sleep(2.2)
                self.assertFalse(marker.exists(), f"Owned descendant survived {mode}")


if __name__ == "__main__":
    unittest.main()
