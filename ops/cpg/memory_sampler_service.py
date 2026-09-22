#!/usr/bin/env python3
"""Start a bounded, non-root sampler through the system systemd manager."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

import memory_sampler as sampler


def unit_name(uid):
    return "cli-memory-sampler-{}.service".format(uid)


def output_directory(uid):
    return Path("/tmp/cli-memory-sampler-{}".format(uid))


def prepare_output(output):
    with sampler.Log(output) as log:
        log.prepare_console()


def start_command(source, output, uid, gid):
    if type(uid) is not int or uid <= 0 or type(gid) is not int or gid < 0:
        raise ValueError("A non-root user and valid group are required")
    if not source.is_absolute() or not output.is_absolute():
        raise ValueError("Absolute source and output paths are required")
    properties = {
        "Type": "exec", "User": str(uid), "Group": str(gid), "Slice": "system.slice",
        "RuntimeMaxSec": "7200", "TimeoutStopSec": "5", "Restart": "no",
        "KillSignal": "SIGINT", "MemoryAccounting": "yes", "MemoryMax": "33554432",
        "CPUAccounting": "yes", "CPUQuota": "5%", "TasksMax": "8",
        "Nice": "19", "IOSchedulingClass": "idle", "LimitFSIZE": "4194304",
        "UMask": "0077", "NoNewPrivileges": "yes", "PrivateDevices": "yes",
        "ProtectSystem": "strict", "ProtectHome": "read-only",
        "ProtectControlGroups": "yes", "ProtectKernelTunables": "yes",
        "ReadWritePaths": str(output), "WorkingDirectory": str(source),
        "StandardInput": "null", "StandardOutput": "append:" + str(output / "console.log"),
        "StandardError": "inherit",
    }
    return [
        "/usr/bin/systemd-run", "--unit=" + unit_name(uid),
        "--description=Bounded CLI memory sampler",
        *["--property={}={}".format(key, value) for key, value in properties.items()],
        "--", "/usr/bin/python3", "-B", str(source / "memory_sampler.py"),
        "--output", str(output), "--label", "new-session",
    ]


def main(argv=None):
    argparse.ArgumentParser(description=__doc__).parse_args(argv)
    uid, gid = os.getuid(), os.getgid()
    try:
        command = start_command(Path(__file__).resolve().parent, output_directory(uid), uid, gid)
        prepare_output(output_directory(uid))
        result = subprocess.run(["sudo", "-n", *command], check=False)
        if result.returncode:
            print("Sampler service not started. Check the systemd/sudo error above. "
                  "If sudo needs authentication, run sudo -v in an ordinary SSH shell "
                  "and rerun this launcher as your normal user, not as root.",
                  file=sys.stderr, flush=True)
            return result.returncode
        print("Submitted {} (2h maximum, no restart). Read status and recent samples "
              "to confirm collection; output: {}".format(unit_name(uid), output_directory(uid)),
              flush=True)
        return 0
    except sampler.READ_ERRORS as error:
        print("Sampler service not started: {} (errno={}). "
              "Use a private non-symlink output directory and only one writer.".format(
                  type(error).__name__, getattr(error, "errno", None)),
              file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
