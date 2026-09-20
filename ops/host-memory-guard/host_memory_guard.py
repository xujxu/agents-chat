#!/usr/bin/env python3
"""System-manager memory containment for a single-user, cgroup-v1 host."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import time

LIMIT = 1536 * 1024 * 1024
MARGIN = 128 * 1024 * 1024
STATE = Path("/var/lib/host-memory-guard")
INSTALLATION = STATE / "installation.json"
ALERT_STATE = STATE / "alert.json"
EXECUTABLE = Path("/usr/local/libexec/host-memory-guard.py")
CGROUP = Path("/sys/fs/cgroup/memory")
SERVICE = "agents-chat.service"
TIMER = "host-memory-guard.timer"
MONITOR_SERVICE = "host-memory-guard.service"


def run(*args, **kwargs):
    return subprocess.run(
        args, check=True, text=True, capture_output=True, timeout=20, **kwargs
    ).stdout.strip()


def properties(unit):
    result = {}
    for line in run(
        "systemctl", "show", unit, "--no-pager",
        "--property=LoadState", "--property=ActiveState", "--property=ControlGroup",
        "--property=MemoryMax", "--property=MemoryAccounting", "--property=MainPID",
        "--property=StartLimitIntervalUSec", "--property=StartLimitBurst",
    ).splitlines():
        key, value = line.split("=", 1)
        result[key] = value
    return result


def counter_file(path):
    result = {}
    for line in path.read_text().splitlines():
        parts = line.replace(":", "").split()
        if len(parts) >= 2:
            result[parts[0]] = int(parts[1])
    return result


def memory_info():
    values = counter_file(Path("/proc/meminfo"))
    return values["MemTotal"] * 1024, values["MemAvailable"] * 1024


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def group_path(unit):
    value = properties(unit)["ControlGroup"]
    if not value.startswith("/") or ".." in Path(value).parts:
        raise RuntimeError("Invalid or missing control group for " + unit)
    return CGROUP / value.lstrip("/")


def group_state(unit):
    path = group_path(unit)
    usage = int((path / "memory.usage_in_bytes").read_text())
    stats = counter_file(path / "memory.stat")
    return {
        "unit": unit,
        "path": str(path),
        "limit_bytes": int((path / "memory.limit_in_bytes").read_text()),
        "usage_bytes": usage,
        "working_set_bytes": max(0, usage - stats.get("total_inactive_file", 0)),
        "hierarchy": int((path / "memory.use_hierarchy").read_text()),
        "oom": counter_file(path / "memory.oom_control"),
        "failcnt": int((path / "memory.failcnt").read_text()),
    }


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_file(path, data, mode=0o644):
    for parent in (path.parent,) + tuple(path.parents):
        if parent.is_symlink():
            raise RuntimeError("Refusing symlink directory: " + str(parent))
    missing = []
    parent = path.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for parent in reversed(missing):
        parent.mkdir(mode=0o755)
        os.chmod(str(parent), 0o755)
    if path.is_symlink():
        raise RuntimeError("Refusing symlink file: " + str(path))
    temporary = path.with_name(path.name + ".install-tmp")
    descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def save_state(value):
    write_file(INSTALLATION, (json.dumps(value, indent=2) + "\n").encode(), 0o600)


def load_state():
    state = json.loads(INSTALLATION.read_text())
    if state["schema"] != 1:
        raise RuntimeError("Unsupported installation state")
    return state


def config_files(uid, source):
    return {
        Path("/etc/systemd/system/user-{}.slice.d/70-host-memory-guard.conf".format(uid)): (
            "[Slice]\nMemoryAccounting=yes\nMemoryMax=1536M\n"
        ).encode(),
        Path("/etc/systemd/system/agents-chat.service.d/70-host-memory-guard.conf"): (
            "[Unit]\nStartLimitIntervalSec=300\nStartLimitBurst=3\n\n"
            "[Service]\nMemoryAccounting=yes\nMemoryMax=1536M\nOOMPolicy=stop\n"
        ).encode(),
        Path("/etc/systemd/system/" + MONITOR_SERVICE): (
            "[Unit]\nDescription=Check bounded application memory and report pressure\n"
            "After=local-fs.target\n\n"
            "[Service]\nType=oneshot\nUser=root\nGroup=root\n"
            "ExecStart=/usr/bin/python3 /usr/local/libexec/host-memory-guard.py monitor\n"
            "StateDirectory=host-memory-guard\nStateDirectoryMode=0700\n"
            "UMask=0077\nMemoryMax=32M\nCPUQuota=5%\nTasksMax=8\n"
            "Nice=10\nTimeoutStartSec=10s\nNoNewPrivileges=yes\n"
            "ProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\n"
            "ProtectKernelTunables=yes\nProtectControlGroups=yes\n"
            "StandardOutput=journal\nStandardError=journal\n"
        ).encode(),
        Path("/etc/systemd/system/" + TIMER): (
            "[Unit]\nDescription=Check host memory containment every 30 seconds\n\n"
            "[Timer]\nOnBootSec=90s\nOnUnitActiveSec=30s\nAccuracySec=2s\n"
            "Unit=host-memory-guard.service\n\n"
            "[Install]\nWantedBy=timers.target\n"
        ).encode(),
        EXECUTABLE: source,
    }


def require_root():
    if os.geteuid() != 0:
        raise RuntimeError("Run this administrative operation with sudo")


def preflight(uid, files):
    if uid <= 0:
        raise RuntimeError("Refusing to limit the root account")
    pwd.getpwuid(uid)
    total, available = memory_info()
    if total < 2 * LIMIT + 768 * 1024 * 1024:
        raise RuntimeError("Host RAM is too small for the approved two-group budget")
    if available < 768 * 1024 * 1024:
        raise RuntimeError("Insufficient host headroom; exit unnecessary work before installing")
    for path in files:
        if path.exists() or path.is_symlink():
            raise RuntimeError("Refusing to overwrite existing file: " + str(path))
    units = ("user-{}.slice".format(uid), SERVICE)
    before = {}
    for unit in units:
        prop = properties(unit)
        if prop["LoadState"] != "loaded" or prop["ActiveState"] != "active":
            raise RuntimeError(unit + " must be active before installation")
        state = group_state(unit)
        if state["hierarchy"] != 1 or state["oom"]["oom_kill_disable"] != 0:
            raise RuntimeError("Hierarchical accounting and group OOM must already be enabled")
        if state["usage_bytes"] >= LIMIT - MARGIN:
            raise RuntimeError(unit + " is too close to the new ceiling; no live reclaim will be forced")
        if state["limit_bytes"] < LIMIT:
            raise RuntimeError("Refusing to weaken an existing lower limit on " + unit)
        before[unit] = {
            "MemoryMax": prop["MemoryMax"],
            "kernel_limit": state["limit_bytes"],
            "failcnt": state["failcnt"],
            "oom_kill": state["oom"].get("oom_kill", 0),
            "MainPID": prop.get("MainPID", "0"),
        }
    run("systemctl", "is-active", "--quiet", SERVICE)
    return before


def verify(state, require_same_pid=False):
    groups = []
    for unit in state["before"]:
        prop = properties(unit)
        if prop["ActiveState"] != "active":
            raise RuntimeError(unit + " is not active")
        value = group_state(unit)
        if value["limit_bytes"] != LIMIT or value["hierarchy"] != 1:
            raise RuntimeError("Kernel memory boundary is not effective for " + unit)
        if value["oom"]["oom_kill_disable"] != 0:
            raise RuntimeError("Group OOM is disabled for " + unit)
        if prop["MemoryMax"] != str(LIMIT):
            raise RuntimeError("Systemd and kernel memory policies disagree for " + unit)
        if require_same_pid:
            if prop.get("MainPID", "0") != state["before"][unit]["MainPID"]:
                raise RuntimeError("Unexpected process restart while installing")
            if value["oom"].get("oom_kill", 0) != state["before"][unit]["oom_kill"]:
                raise RuntimeError("Unexpected group OOM while installing")
        groups.append(value)
    prod = properties(SERVICE)
    if prod["StartLimitBurst"] != "3" or prod["StartLimitIntervalUSec"] != "5min":
        raise RuntimeError("PROD restart rate limit did not apply")
    for filename, expected in state["files"].items():
        if digest(Path(filename).read_bytes()) != expected:
            raise RuntimeError("Installed configuration changed: " + filename)
    return groups


def restore(state):
    for filename, expected in state["files"].items():
        path = Path(filename)
        if path.is_symlink() or (path.exists() and digest(path.read_bytes()) != expected):
            raise RuntimeError("Refusing to remove a modified installed file: " + filename)
    for unit, previous in state["before"].items():
        if group_state(unit)["limit_bytes"] not in (LIMIT, previous["kernel_limit"]):
            raise RuntimeError("Refusing to overwrite a changed live memory limit: " + unit)
    if properties(TIMER)["LoadState"] != "not-found":
        run("systemctl", "disable", "--now", TIMER)
    if properties(MONITOR_SERVICE)["LoadState"] != "not-found":
        run("systemctl", "stop", MONITOR_SERVICE)
    for unit, previous in state["before"].items():
        run("systemctl", "set-property", "--runtime", unit, "MemoryMax=" + previous["MemoryMax"])
    for filename in state["files"]:
        path = Path(filename)
        if path.exists():
            path.unlink()
    run("systemctl", "daemon-reload")
    for unit, previous in state["before"].items():
        if group_state(unit)["limit_bytes"] != previous["kernel_limit"]:
            raise RuntimeError("Previous kernel memory limit was not restored: " + unit)
    state["phase"] = "rolled_back"
    state["rolled_back_at"] = time.time()
    save_state(state)


def install(uid):
    require_root()
    if INSTALLATION.exists():
        state = load_state()
        if state["phase"] == "installed" and state["uid"] == uid:
            print(json.dumps({"already_installed": True, "groups": verify(state)}, indent=2))
            return
        raise RuntimeError("Previous installation state exists; inspect it before proceeding")
    files = config_files(uid, Path(__file__).read_bytes())
    before = preflight(uid, files)
    if STATE.is_symlink():
        raise RuntimeError("Refusing symlink state directory")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(str(STATE), 0o700)
    state = {
        "schema": 1, "phase": "installing", "uid": uid,
        "created_at": time.time(), "boot_id": boot_id(), "before": before,
        "files": {str(path): digest(data) for path, data in files.items()},
    }
    save_state(state)
    try:
        for path, data in files.items():
            write_file(path, data, 0o755 if path == EXECUTABLE else 0o644)
        run("systemctl", "daemon-reload")
        for unit in before:
            run("systemctl", "set-property", "--runtime", unit, "MemoryMax=" + str(LIMIT))
        groups = verify(state, require_same_pid=True)
        state["phase"] = "installed"
        save_state(state)
        run("systemctl", "enable", "--now", TIMER)
        run("systemctl", "start", MONITOR_SERVICE)
        run("systemctl", "is-active", "--quiet", TIMER)
        print(json.dumps({"installed": True, "no_prod_restart": True, "groups": groups}, indent=2))
    except Exception:
        print("Installation failed; attempting scoped rollback.", file=sys.stderr)
        restore(state)
        raise


def alert_reasons(available, groups):
    reasons = []
    if available < 256 * 1024 * 1024:
        reasons.append("CRITICAL host available memory below 256 MiB")
    elif available < 512 * 1024 * 1024:
        reasons.append("WARNING host available memory below 512 MiB")
    for group in groups:
        unit = group["unit"]
        if group["limit_bytes"] != LIMIT or group["hierarchy"] != 1 or group["oom"]["oom_kill_disable"] != 0:
            reasons.append("CRITICAL memory containment missing for " + unit)
        elif group["working_set_bytes"] >= LIMIT * 95 // 100:
            reasons.append("CRITICAL " + unit + " working set at least 95% of ceiling")
        elif group["working_set_bytes"] >= LIMIT * 80 // 100:
            reasons.append("WARNING " + unit + " working set at least 80% of ceiling")
    return reasons


def monitor():
    require_root()
    state = load_state()
    if state["phase"] != "installed":
        raise RuntimeError("Memory guard installation is incomplete")
    _, available = memory_info()
    current_boot = boot_id()
    groups = []
    reasons = []
    for unit in state["before"]:
        prop = properties(unit)
        if prop["ActiveState"] == "active":
            groups.append(group_state(unit))
        elif unit == SERVICE:
            reasons.append("CRITICAL PROD service is not active")
    reasons.extend(alert_reasons(available, groups))
    previous = json.loads(ALERT_STATE.read_text()) if ALERT_STATE.exists() else {}
    for group in groups:
        baseline = state["before"][group["unit"]]["oom_kill"] if state.get("boot_id") == current_boot else 0
        prior = previous.get("oom_kills", {}).get(group["unit"], baseline) if previous.get("boot_id") == current_boot else baseline
        if group["oom"].get("oom_kill", 0) > prior:
            reasons.append("CRITICAL group-local OOM killed a task in " + group["unit"])
    now = time.time()
    signature = "\n".join(reasons)
    send = bool(reasons) and (
        signature != previous.get("signature") or now - previous.get("last_notice", 0) >= 300
    )
    report = {"available_mib": available // 1024 // 1024, "groups": groups, "alerts": reasons}
    print(json.dumps(report, separators=(",", ":")), flush=True)
    if send:
        message = (
            "HOST MEMORY GUARD: " + "; ".join(reasons)
            + ". Save work and exit unnecessary CLI tasks. Do not start new workloads.\n"
        )
        run("/usr/bin/wall", "--nobanner", "--timeout", "2", input=message)
    elif previous.get("signature") and not reasons:
        print("HOST MEMORY GUARD: pressure recovered; hard limits remain active.", flush=True)
    updated = {
        "boot_id": current_boot,
        "signature": signature,
        "last_notice": now if send else previous.get("last_notice", 0),
        "oom_kills": {g["unit"]: g["oom"].get("oom_kill", 0) for g in groups},
    }
    write_file(ALERT_STATE, json.dumps(updated).encode(), 0o600)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "status", "monitor", "rollback"))
    parser.add_argument("--uid", type=int)
    args = parser.parse_args()
    require_root()
    if args.action == "install":
        if args.uid is None:
            parser.error("install requires --uid")
        install(args.uid)
    elif args.action == "monitor":
        monitor()
    elif args.action == "status":
        state = load_state()
        print(json.dumps({"phase": state["phase"], "groups": verify(state)}, indent=2))
        print(run("systemctl", "is-enabled", TIMER))
        print(run("systemctl", "is-active", TIMER))
    else:
        state = load_state()
        if state["phase"] == "rolled_back":
            print("Already rolled back")
            return
        restore(state)
        print("Previous limits restored; PROD was not restarted. Installation record retained.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("host-memory-guard: " + str(error), file=sys.stderr)
        sys.exit(1)
