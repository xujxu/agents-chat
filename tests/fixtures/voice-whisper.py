#!/usr/bin/env python3
import pathlib
import os
import struct
import sys
import time

args = sys.argv[1:]
output = pathlib.Path(args[args.index("-of") + 1] + ".txt")
marker = output.parent / "child.pid"
marker.write_text(str(os.getpid()), encoding="ascii")
audio = pathlib.Path(args[args.index("-f") + 1]).read_bytes()
samples = struct.unpack_from("<16h", audio, 44) if len(audio) >= 76 else ()
sample = samples[0] if samples and min(samples) == max(samples) else 0
if sample == 16384:
    allocation = bytearray(400 * 1024 * 1024)
    for offset in range(0, len(allocation), 4096):
        allocation[offset] = 1
time.sleep(30 if sample in (13107, 16384) else 0.4)
output.write_text("你好，voice PoC.\n", encoding="utf-8")
