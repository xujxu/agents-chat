#!/usr/bin/env python3
import os
import pathlib
import struct
import subprocess
import sys
import time

args = sys.argv[1:]
sense = "-a" in args
audio_path = pathlib.Path(args[args.index("-a" if sense else "-f") + 1])
directory = audio_path.parent
(directory / "child.pid").write_text(str(os.getpid()), encoding="ascii")
mode = pathlib.Path(args[args.index("-m") + 1]).read_text().strip()
audio = audio_path.read_bytes()
samples = struct.unpack_from("<16h", audio, 44) if len(audio) >= 76 else ()
sample = samples[0] if samples and min(samples) == max(samples) else 0
if sample == 13107 or mode == "wait":
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    (directory / "descendant.pid").write_text(str(child.pid), encoding="ascii")
    time.sleep(120)
if mode == "fail":
    sys.exit(3)
if mode == "memory":
    allocation = bytearray(400 * 1024 * 1024)
    time.sleep(0.5)
if mode == "stderr":
    sys.stderr.write("diagnostic" * 100000)
time.sleep(0.4)
output = {
    "empty": b" \n", "oversized": b"x" * 32769, "invalid": b"\xff", "nul": b"a\0b",
}.get(mode, "\u4f60\u597d\uff0cvoice PoC.\n".encode())
if sense:
    sys.stdout.buffer.write(output)
elif mode != "missing":
    pathlib.Path(args[args.index("-of") + 1] + ".txt").write_bytes(output)
