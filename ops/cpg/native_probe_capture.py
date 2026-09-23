"""Direct subject launch avoids older heaptrack wrappers masking exit status."""
import gzip
import os
from pathlib import Path
import resource
import shutil
import subprocess
import time


def profiler_paths():
    listing = subprocess.check_output(["dpkg-query", "-L", "libheaptrack"], text=True, timeout=10)
    paths = {}
    for name in ("libheaptrack_preload.so", "heaptrack_interpret"):
        matches = [Path(line) for line in listing.splitlines()
                   if Path(line).name == name and Path(line).is_file()]
        if len(matches) != 1:
            raise RuntimeError("Expected one packaged heaptrack component: " + name)
        paths[name] = str(matches[0])
    return paths


def capture(command, directory, env, expected):
    paths = profiler_paths()
    fifo = directory / "trace.fifo"
    os.mkfifo(fifo, 0o600)
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    subject = interpreter = None
    # RDWR avoids blocking open before the subject starts. The parent's writer
    # is closed after subject exit so the interpreter sees EOF even after SIGKILL.
    pipe_fd = os.open(fifo, os.O_RDWR | os.O_CLOEXEC)
    try:
        with fifo.open("rb") as pipe, \
                (directory / "trace.interpreted").open("wb") as trace, \
                (directory / "interpreter-stderr.txt").open("w") as errors, \
                (directory / "stdout.txt").open("w") as out, \
                (directory / "stderr.txt").open("w") as err:
            interpreter = subprocess.Popen([paths["heaptrack_interpret"]], stdin=pipe,
                                           stdout=trace, stderr=errors, env=env, cwd=directory)
            subject_env = dict(env, LD_PRELOAD=paths["libheaptrack_preload.so"],
                               DUMP_HEAPTRACK_OUTPUT=str(fifo))
            subject = subprocess.Popen(command, env=subject_env, cwd=directory,
                                       stdin=subprocess.PIPE, stdout=out, stderr=err)
            code = subject.wait(timeout=60)
            os.close(pipe_fd)
            pipe_fd = None
            interpreter_code = interpreter.wait(timeout=30)
            if code not in expected:
                raise RuntimeError("Subject exit {} in {}".format(code, directory))
            if interpreter_code != 0:
                raise RuntimeError("Interpreter exit {} in {}".format(interpreter_code, directory))
    finally:
        if pipe_fd is not None:
            os.close(pipe_fd)
        for process in (subject, interpreter):
            if process is not None:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                if process is subject:
                    process.stdin.close()
        fifo.unlink()
    raw = directory / "trace.interpreted"
    with raw.open("rb") as source, gzip.open(directory / "trace.gz", "wb") as destination:
        shutil.copyfileobj(source, destination, 1024 * 1024)
    raw.unlink()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"exit_code": code, "wall_seconds": time.monotonic() - started,
            "cpu_seconds": after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime}
