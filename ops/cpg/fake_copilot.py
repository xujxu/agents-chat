#!/usr/bin/python3
"""Disposable-VM fixture; never installed on the production host."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

if "--allocate" in sys.argv:
    chunks = []
    while True:
        chunks.append(bytearray(32 * 1024 * 1024))
        time.sleep(0.02)
elif "--hold" in sys.argv:
    print("READY", flush=True)
    time.sleep(180)
else:
    print(json.dumps({
        "args": sys.argv[1:],
        "uid": os.getuid(),
        "cwd": os.getcwd(),
        "marker": os.environ.get("CPG_TEST_MARKER"),
        "group": Path("/proc/self/cgroup").read_text(),
        "child_group": subprocess.check_output(
            ["/bin/cat", "/proc/self/cgroup"], text=True,
        ),
    }))
