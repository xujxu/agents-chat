#!/usr/bin/env python3
import pathlib
import sys
import time

args = sys.argv[1:]
time.sleep(0.4)
output = pathlib.Path(args[args.index("-of") + 1] + ".txt")
output.write_text("你好，voice PoC.\n", encoding="utf-8")
