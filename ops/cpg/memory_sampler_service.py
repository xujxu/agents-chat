#!/usr/bin/env python3
"""Manage bounded transient or persistent non-root system sampling."""
import argparse
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys

import memory_sampler as sampler

LIB = Path("/usr/local/libexec/cli-memory-sampler")
UNITS = Path("/etc/systemd/system")


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


def persistent_unit(uid, gid):
    if type(uid) is not int or uid <= 0 or type(gid) is not int or gid < 0:
        raise ValueError("A non-root user and valid group are required")
    state = "cli-memory-sampler-{}".format(uid)
    return (
        "[Unit]\nDescription=Continuous bounded CLI memory sampler\n"
        "After=cpg-setup.service\nWants=cpg-setup.service\nStartLimitIntervalSec=0\n\n"
        "[Service]\nType=exec\nUser={uid}\nGroup={gid}\nSlice=system.slice\n"
        "RuntimeMaxSec=infinity\nTimeoutStopSec=5\nRestart=on-failure\nRestartSec=30\n"
        "KillSignal=SIGINT\nMemoryAccounting=yes\nMemoryMax=33554432\n"
        "CPUAccounting=yes\nCPUQuota=5%\nTasksMax=8\nNice=19\nIOSchedulingClass=idle\n"
        "LimitFSIZE=4194304\nUMask=0077\nNoNewPrivileges=yes\nPrivateDevices=yes\n"
        "ProtectSystem=strict\nProtectHome=yes\nProtectControlGroups=yes\n"
        "ProtectKernelTunables=yes\nStateDirectory={state}\nStateDirectoryMode=0700\n"
        "RuntimeDirectory={state}\nRuntimeDirectoryMode=0700\n"
        "StandardInput=null\nStandardOutput=journal\nStandardError=inherit\n"
        "LogRateLimitIntervalSec=60s\nLogRateLimitBurst=10\n"
        "ExecStart=/usr/bin/python3 -B {lib}/memory_sampler.py "
        "--output /var/lib/{state} --label continuous --continuous "
        "--runtime-socket /run/{state}/runtime.sock\n\n"
        "[Install]\nWantedBy=multi-user.target\n"
    ).format(uid=uid, gid=gid, state=state, lib=LIB)


def root_directory(path):
    for directory in reversed([path, *path.parents]):
        try:
            directory.mkdir(mode=0o755)
        except FileExistsError:
            pass
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022):
            raise RuntimeError("Installation requires root-owned non-writable directories")


def install(uid):
    if os.getuid() != 0:
        raise RuntimeError("--install requires sudo; the installed sampler itself runs non-root")
    account = pwd.getpwuid(uid)
    unit = persistent_unit(uid, account.pw_gid)
    source = Path(__file__).resolve().parent
    sources = {name: (source / name).read_bytes() for name in (
        "memory_sampler.py", "memory_sampler_incident.py", "memory_sampler_metrics.py",
        "memory_sampler_runtime.py", "memory_sampler_launch.py",
        "memory_sampler_anomalies.py",
        "memory_sampler_preload.cjs", "cpg_common.py",
    )}
    root_directory(LIB)
    root_directory(UNITS)
    name = unit_name(uid)
    state = subprocess.run(
        ["systemctl", "show", name, "--property=LoadState", "--value"],
        text=True, capture_output=True, check=True,
    ).stdout.strip()
    if state != "not-found":
        subprocess.run(["systemctl", "stop", name], check=True)
        failed = subprocess.run(["systemctl", "is-failed", "--quiet", name], check=False)
        if failed.returncode == 0:
            subprocess.run(["systemctl", "reset-failed", name], check=True)
        elif failed.returncode != 1:
            raise RuntimeError("Unable to determine previous sampler failure state")
    for filename, content in sources.items():
        sampler.common.write_bytes(LIB / filename, content, mode=0o644)
    sampler.common.write_bytes(UNITS / name, unit.encode(), mode=0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", name], check=True)
    subprocess.run(["systemctl", "is-active", "--quiet", name], check=True)
    print("Installed {}: continuous, boot-enabled; output /var/lib/cli-memory-sampler-{}. "
          "Confirm fresh samples before relying on collection.".format(name, uid), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true",
                        help="Install and enable continuous system service (requires sudo)")
    parser.add_argument("--uid", type=int, help="Non-root account for --install")
    args = parser.parse_args(argv)
    if args.install != (args.uid is not None):
        parser.error("--install and --uid must be supplied together")
    uid, gid = os.getuid(), os.getgid()
    try:
        if args.install:
            install(args.uid)
            return 0
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
    except (*sampler.READ_ERRORS, subprocess.CalledProcessError) as error:
        print("Sampler service not started: {} (errno={}). "
              "Use a private non-symlink output directory and only one writer.".format(
                  type(error).__name__, getattr(error, "errno", None)),
              file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
