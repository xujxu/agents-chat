"""CI-only native runner; feature inputs never enter the application API."""

import base64
import hashlib
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time


def native_environment():
    if sys.platform != "win32":
        return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "NODE_ENV": "production"}
    root = next((v for k, v in os.environ.items() if k.lower() == "systemroot"), None)
    if not root or not Path(root).is_absolute():
        raise ValueError("Windows SystemRoot is required")
    return {"SystemRoot": root, "WINDIR": root, "PATH": f"{root}\\System32;{root}",
            "TEMP": tempfile.gettempdir(), "TMP": tempfile.gettempdir(), "NODE_ENV": "production"}


def run_native(binary, args, helper=None, timeout=120, cancel=None):
    if not math.isfinite(timeout) or not 0 < timeout <= 120:
        raise ValueError("Invalid native deadline")
    windows = sys.platform == "win32"
    if windows != bool(helper):
        raise ValueError("Windows requires the verified helper; Linux must use process groups")
    if cancel is not None and cancel.is_set():
        return {"text": None, "failure": "voice_cancelled", "seconds": 0,
                "stdoutBase64": None, "stdoutSha256": None}
    command = [str(Path(binary).resolve()), *map(str, args)]
    if windows:
        command = [str(Path(helper).resolve()), str(max(1, int(timeout * 1000))), *command]
    started = time.monotonic()
    child = subprocess.Popen(command, stdin=subprocess.PIPE if windows else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=native_environment(),
                             start_new_session=not windows,
                             creationflags=subprocess.CREATE_NO_WINDOW if windows else 0)
    buffers = [bytearray(), bytearray()]
    failures = []
    lock = threading.Lock()

    def fail(code):
        with lock:
            if not failures:
                failures.append(code)

    def drain(pipe, index, limit):
        try:
            while True:
                data = pipe.read1(4096)
                if not data:
                    return
                if len(buffers[index]) + len(data) > limit:
                    fail("voice_invalid_result" if index == 0 else "voice_process_failed")
                else:
                    buffers[index].extend(data)
        except OSError:
            fail("voice_process_failed")

    readers = [threading.Thread(target=drain, args=(child.stdout, 0, 32768), daemon=True),
               threading.Thread(target=drain, args=(child.stderr, 1, 256 if windows else 65536), daemon=True)]
    for reader in readers:
        reader.start()

    def terminate():
        if windows:
            try:
                child.stdin.close()
            except BrokenPipeError:
                pass
            try:
                child.wait(timeout=6)
            except subprocess.TimeoutExpired as error:
                child.kill()
                child.wait(timeout=6)
                raise RuntimeError("Windows Job teardown deadline exceeded; evidence incomplete") from error
        else:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=6)

    try:
        while child.poll() is None:
            if cancel is not None and cancel.is_set():
                fail("voice_cancelled")
            if time.monotonic() - started >= timeout:
                fail("voice_timeout")
            if failures:
                break
            time.sleep(.01)
    finally:
        # Even a successful parent may have left descendants holding the pipes.
        terminate()
        for reader in readers:
            reader.join(timeout=6)
        if any(reader.is_alive() for reader in readers):
            raise RuntimeError("Native pipes remain open after tree cleanup; evidence incomplete")
        child.stdout.close()
        child.stderr.close()
    raw, diagnostic = map(bytes, buffers)
    if not failures:
        if windows and child.returncode == 124 and diagnostic in (b"voice_job_timeout\n", b"voice_job_timeout\r\n"):
            fail("voice_timeout")
        elif windows and diagnostic:
            fail("voice_process_failed")
        elif child.returncode != 0:
            fail("voice_inference_failed")
    text = None
    if not failures:
        try:
            text = raw.decode("utf-8").strip()
        except UnicodeDecodeError:
            fail("voice_invalid_result")
        else:
            if "\0" in text:
                fail("voice_invalid_result")
            elif not text:
                fail("voice_no_speech")
    return {"text": None if failures else text, "failure": failures[0] if failures else None,
            "seconds": time.monotonic() - started,
            "stdoutBase64": None if failures else base64.b64encode(raw).decode("ascii"),
            "stdoutSha256": None if failures else hashlib.sha256(raw).hexdigest()}
