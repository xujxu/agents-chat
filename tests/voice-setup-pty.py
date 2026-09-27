"""Exercise the actual installer with a terminal, not a mocked isTTY flag."""
import errno
import os
import pathlib
import pty
import select
import shutil
import signal
import tempfile
import time
import unittest


class InteractiveSetup(unittest.TestCase):
    def invoke(self, root, answer):
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(shutil.which("node"), [
                "node", "scripts/configure-voice.mjs", "--project-dir", str(root),
            ], {"PATH": os.environ["PATH"]})
        output = bytearray()
        sent = False
        completed = False
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(fd, 4096)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b""
                    output.extend(chunk)
                    if not sent and b"Voice setup [1]: " in output:
                        os.write(fd, answer)
                        sent = True
                result, status = os.waitpid(pid, os.WNOHANG)
                if result:
                    completed = True
                    self.assertTrue(sent, output.decode())
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0, output.decode())
                    return output.decode()
            self.fail("Interactive setup did not finish")
        finally:
            if not completed:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(fd)

    def test_every_upgrade_prompts_and_preserves_by_default(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            original = "VOICE_ENABLED=1\nVOICE_WHISPER_PATH=/old/engine\nVOICE_MODEL_PATH=/old/model\n"
            config = root / ".env.local"
            config.write_text(original)
            for answer in (b"\n", b"1\n", b"\x04", b"\x03"):
                self.invoke(root, answer)
                self.assertEqual(config.read_text(), original)
            self.invoke(root, b"4\n")
            self.assertEqual(config.read_text(), "VOICE_ENABLED=0\n")
            self.invoke(root, b"\n")
            self.assertEqual(config.read_text(), "VOICE_ENABLED=0\n")

    def test_first_install_opt_out(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            self.invoke(root, b"4\n")
            self.assertEqual((root / ".env.local").read_text(), "VOICE_ENABLED=0\n")


if __name__ == "__main__":
    unittest.main()
