#!/usr/bin/python3 -I
"""Root-only installation, lifecycle and numeric monitoring; never executes Copilot."""
import argparse
import hashlib
import os
from pathlib import Path
import pwd
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, "/usr/local/libexec/cpg")
import cpg_common as common

UNITS = Path("/etc/systemd/system")
SETUP = "cpg-setup.service"
MONITOR = "cpg-monitor.service"
TIMER = "cpg-monitor.timer"
SLICE = "cpg.slice"


def systemctl(*arguments):
    result = subprocess.run(
        ["/bin/systemctl", *arguments], capture_output=True, text=True, timeout=25,
    )
    if result.returncode:
        raise RuntimeError("systemctl {} failed: {}".format(
            " ".join(arguments), (result.stderr or result.stdout).strip(),
        ))
    return result.stdout.strip()


def mkdir(path, mode=0o755):
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise RuntimeError("Refusing symlink directory: " + str(path))
    if not path.exists():
        path.mkdir(parents=True, mode=mode)
        path.chmod(mode)
    elif path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
        raise RuntimeError("Unsafe directory permissions: " + str(path))


def ensure_lock():
    if not common.LOCK.exists():
        descriptor = os.open(str(common.LOCK), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        os.fchmod(descriptor, 0o644)
        os.close(descriptor)


def slice_file(enabled):
    return (
        "[Unit]\nDescription=Root-owned aggregate ceiling for terminal Copilot tasks\n\n"
        "[Slice]\nMemoryAccounting=yes\nMemoryMax=" + ("1536M" if enabled else "infinity") + "\n"
    ).encode()


def files(source, uid, gid):
    return {
        common.LIB / "cpg_common.py": (source / "cpg_common.py").read_bytes(),
        common.LAUNCHER: (source / "cpg_launcher.py").read_bytes(),
        common.ADMIN: (source / "cpg_admin.py").read_bytes(),
        UNITS / SLICE: slice_file(True),
        UNITS / common.WORKLOAD: (
            "[Unit]\nDescription=Delegated terminal Copilot processes (not SSH or Web)\n\n"
            "[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\n"
            "User={}\nGroup={}\nSlice=cpg.slice\nDelegate=yes\n"
            "MemoryAccounting=yes\nOOMPolicy=continue\n".format(uid, gid)
        ).encode(),
        UNITS / SETUP: (
            "[Unit]\nDescription=Initialize terminal-only Copilot memory group\n"
            "Requires=cpg-workload.service\nAfter=local-fs.target cpg-workload.service\n"
            "Before=multi-user.target\n\n"
            "[Service]\nType=oneshot\nRemainAfterExit=yes\n"
            "ExecStart=/usr/local/sbin/cpgctl boot\n"
            "MemoryMax=32M\nTasksMax=8\nTimeoutStartSec=15\n"
            "NoNewPrivileges=yes\nUMask=0077\n\n"
            "[Install]\nWantedBy=multi-user.target\n"
        ).encode(),
        UNITS / MONITOR: (
            "[Unit]\nDescription=Report terminal Copilot memory pressure\nAfter=cpg-setup.service\n\n"
            "[Service]\nType=oneshot\nExecStart=/usr/local/sbin/cpgctl monitor\n"
            "StateDirectory=cpg\nStateDirectoryMode=0700\nUMask=0077\n"
            "MemoryMax=32M\nCPUQuota=5%\nTasksMax=8\nTimeoutStartSec=10\nNice=10\n"
            "NoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\n"
            "ProtectControlGroups=yes\nProtectKernelTunables=yes\nPrivateTmp=yes\n"
        ).encode(),
        UNITS / TIMER: (
            "[Unit]\nDescription=Check terminal Copilot memory every 30 seconds\n\n"
            "[Timer]\nOnBootSec=90s\nOnUnitActiveSec=30s\nAccuracySec=2s\n"
            "Unit=cpg-monitor.service\n\n[Install]\nWantedBy=timers.target\n"
        ).encode(),
    }


def fingerprint(data):
    return hashlib.sha256(data).hexdigest()


def record():
    value = common.read_json(common.RECORD)
    if value["schema"] != 1:
        raise RuntimeError("Unsupported installation record")
    return value


def check_files(value):
    for name, expected in value["files"].items():
        path = Path(name)
        if path.is_symlink() or fingerprint(path.read_bytes()) != expected:
            raise RuntimeError("Refusing modified installation file: " + name)
    if common.load_config() != value["config"]:
        raise RuntimeError("Configuration differs from the installation record")


def write_configuration(value, config):
    common.write_json(common.CONFIG, config)
    value["config"] = config
    common.write_json(common.RECORD, value, 0o600)


def configure_group(config):
    common.memory_membership(Path("/proc/self/cgroup").read_text())
    if not (common.CONTROLLER / "memory.limit_in_bytes").exists():
        raise RuntimeError("This installer supports only the host's cgroup-v1 memory controller")
    if not common.GROUP.exists():
        raise RuntimeError("Systemd did not create the cpg memory slice")
    if common.GROUP.stat().st_uid != 0:
        raise RuntimeError("Memory group must be root-owned")
    current = common.read_group()
    if config["enabled"] and current["usage"] >= common.LIMIT - 128 * common.MIB:
        raise RuntimeError("Existing protected tasks are too close to the ceiling; exit them before enabling")
    (common.GROUP / "memory.use_hierarchy").write_text("1")
    (common.GROUP / "memory.oom_control").write_text("0")
    if config["enabled"]:
        (common.GROUP / "memory.limit_in_bytes").write_text(str(common.LIMIT))
        common.verify_boundary(common.read_group())
    else:
        remove_limit()


def remove_limit():
    if common.GROUP.exists():
        if common.GROUP.stat().st_uid != 0:
            raise RuntimeError("Refusing unowned memory group")
        (common.GROUP / "memory.limit_in_bytes").write_text("-1")
        if common.read_group()["limit"] < common.memory_info()[0]:
            raise RuntimeError("Kernel did not remove the memory ceiling")


def stop_monitor():
    if (UNITS / TIMER).exists():
        systemctl("disable", "--now", TIMER)
    if (UNITS / MONITOR).exists():
        systemctl("stop", MONITOR)


def stop_units():
    systemctl("daemon-reload")
    stop_monitor()
    if (UNITS / SETUP).exists():
        systemctl("disable", "--now", SETUP)
    for name in (common.WORKLOAD, SLICE):
        if (UNITS / name).exists():
            systemctl("stop", name)


def uninstall(value, partial=False):
    if common.GROUP.exists() and common.group_pids():
        raise RuntimeError("Protected Copilot tasks are still running; exit them before uninstalling")
    if not partial:
        check_files(value)
    else:
        for name, expected in value["files"].items():
            path = Path(name)
            if path.is_symlink() or (path.exists() and fingerprint(path.read_bytes()) != expected):
                raise RuntimeError("Refusing to remove changed partial-install file: " + name)
    remove_limit()
    stop_units()
    if common.GROUP.exists():
        raise RuntimeError("Systemd has not removed the empty cpg slice; retry uninstall")
    for name in value["files"]:
        path = Path(name)
        if path.exists():
            path.unlink()
    if common.CONFIG.exists():
        common.CONFIG.unlink()
    systemctl("daemon-reload")
    for path in (common.STATE / "alert.json", common.RECORD):
        if path.exists():
            path.unlink()
    for path in (common.LIB, common.CONFIG.parent, common.STATE):
        if path.exists() and not any(path.iterdir()):
            path.rmdir()
    common.LOCK.unlink()
    print("cpg uninstalled. No application configuration was changed; journal history retained.")


def install(uid, executable):
    if uid is None or uid <= 0 or not executable:
        raise RuntimeError("install requires a non-root --uid and absolute --copilot path")
    user = pwd.getpwuid(uid)
    binary = Path(executable)
    if not binary.is_absolute() or not binary.is_file() or not os.access(str(binary), os.X_OK):
        raise RuntimeError("--copilot must name an existing absolute executable path")
    if binary.resolve() in (common.LAUNCHER, common.ADMIN):
        raise RuntimeError("The original Copilot binary must not point back to this launcher")
    total, available = common.memory_info()
    if total < common.LIMIT + 512 * common.MIB or available < 768 * common.MIB:
        raise RuntimeError("Insufficient host memory headroom for installation")
    common.memory_membership(Path("/proc/self/cgroup").read_text())
    package = files(Path(__file__).resolve().parent, uid, user.pw_gid)
    for path in (*package, common.CONFIG, common.RECORD, common.GROUP):
        if path.exists() or path.is_symlink():
            raise RuntimeError("Refusing existing installation target: " + str(path))
    for path in (common.CONFIG.parent, common.LIB, common.ADMIN.parent, common.LAUNCHER.parent):
        mkdir(path)
    mkdir(common.STATE, 0o700)
    config = {"schema": 1, "uid": uid, "gid": user.pw_gid, "executable": str(binary), "enabled": True}
    common.validate_config(config)
    value = {
        "schema": 1, "phase": "installing", "config": config,
        "files": {str(path): fingerprint(data) for path, data in package.items()},
    }
    common.write_json(common.RECORD, value, 0o600)
    try:
        for path, data in package.items():
            common.write_bytes(path, data, 0o755 if path in (common.LAUNCHER, common.ADMIN) else 0o644)
        common.write_json(common.CONFIG, config)
        systemctl("daemon-reload")
        systemctl("start", common.WORKLOAD)
        configure_group(config)
        systemctl("enable", SETUP, TIMER)
        systemctl("start", TIMER)
        value["phase"] = "installed"
        common.write_json(common.RECORD, value, 0o600)
        print("cpg installed: only future cpg launches are protected; existing processes were not moved.")
        print(json_report(config))
    except Exception:
        print("Installation failed; attempting removal of this partial installation.", file=sys.stderr)
        uninstall(value, partial=True)
        raise


def set_enabled(value, enabled):
    check_files(value)
    config = dict(value["config"], enabled=enabled)
    if enabled:
        _, available = common.memory_info()
        if available < 768 * common.MIB:
            raise RuntimeError("Insufficient host headroom to enable protection")
        if common.GROUP.exists() and common.read_group()["usage"] >= common.LIMIT - 128 * common.MIB:
            raise RuntimeError("Existing protected tasks are too close to the ceiling; exit them before enabling")
    content = slice_file(enabled)
    common.write_bytes(UNITS / SLICE, content)
    value["files"][str(UNITS / SLICE)] = fingerprint(content)
    write_configuration(value, config)
    systemctl("daemon-reload")
    systemctl("start", common.WORKLOAD)
    configure_group(config)
    if enabled:
        systemctl("enable", SETUP, TIMER)
        systemctl("start", TIMER)
        print("cpg enabled: shared hard ceiling is 1536 MiB.")
    else:
        stop_monitor()
        print("cpg disabled: memory ceiling and alerts removed; running tasks were not killed.")


def upgrade_launcher(value):
    """Update only launcher/admin code, leaving live tasks and guard units alone."""
    check_files(value)
    if value["phase"] != "installed":
        raise RuntimeError("Finish or remove the partial installation before upgrading")
    source = Path(__file__).resolve().parent
    if (source / "cpg_common.py").read_bytes() != common.LIB.joinpath("cpg_common.py").read_bytes():
        raise RuntimeError("Launcher-only upgrade requires matching common policy code")
    replacements = {
        common.LAUNCHER: (source / "cpg_launcher.py").read_bytes(),
        common.ADMIN: (source / "cpg_admin.py").read_bytes(),
    }
    original = {path: path.read_bytes() for path in replacements}
    updated = dict(value, files=dict(value["files"]))
    try:
        for path, content in replacements.items():
            common.write_bytes(path, content, mode=0o755)
            updated["files"][str(path)] = fingerprint(content)
        common.write_json(common.RECORD, updated, 0o600)
    except Exception:
        print("Launcher upgrade failed; restoring previous launcher/admin files.", file=sys.stderr)
        for path, content in original.items():
            common.write_bytes(path, content, mode=0o755)
        common.write_json(common.RECORD, value, 0o600)
        raise
    print("cpg launcher upgraded. Existing tasks, guard limits and units were not changed.")


def json_report(config):
    import json
    report = {"enabled": config["enabled"], "configured_uid": config["uid"]}
    if common.GROUP.exists():
        report["group"] = common.read_group()
        report["protected_pids"] = common.group_pids()
    return json.dumps(report, indent=2)


def monitor():
    import json
    try:
        with common.locked(nonblocking=True):
            config = common.load_config()
            if not config["enabled"]:
                print("cpg monitoring is disabled")
                return
            group = common.read_group()
            _, available = common.memory_info()
            reasons = common.pressure_reasons(available, group)
            try:
                common.verify_boundary(group)
            except RuntimeError as error:
                reasons.append("CRITICAL " + str(error))
            now = time.time()
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            path = common.STATE / "alert.json"
            previous = common.read_json(path) if path.exists() else {}
            prior_oom = previous.get("oom_kills", 0) if previous.get("boot_id") == boot else 0
            if group["oom_kills"] > prior_oom:
                reasons.append("CRITICAL kernel OOM in protected Copilot group")
            print(json.dumps({"available_bytes": available, "group": group, "alerts": reasons}), flush=True)
            signature = "; ".join(reasons)
            notify = bool(reasons) and (
                signature != previous.get("signature") or now - previous.get("last_notice", 0) >= 300
            )
            if notify:
                subprocess.run(
                    ["/usr/bin/wall", "--nobanner", "--timeout", "2"],
                    input="CPG: " + signature + ". Save work; exit unnecessary CLI tasks.\n",
                    text=True, check=True, timeout=3,
                )
            elif previous.get("signature") and not signature:
                print("CPG: pressure recovered; protection remains enabled.", flush=True)
            common.write_json(path, {
                "boot_id": boot, "oom_kills": group["oom_kills"], "signature": signature,
                "last_notice": now if notify else previous.get("last_notice", 0),
            }, 0o600)
    except BlockingIOError:
        print("cpg lifecycle operation in progress; deferring this monitoring tick.", flush=True)


def main():
    os.umask(0o022)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "upgrade-launcher", "enable", "disable",
                                          "uninstall", "status", "boot", "monitor"))
    parser.add_argument("--uid", type=int)
    parser.add_argument("--copilot")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Use sudo for cpg administration; never use sudo to launch cpg")
    if args.action == "monitor":
        monitor()
        return
    if args.action in ("install", "boot"):
        ensure_lock()
    with common.locked(exclusive=True):
        if args.action == "install":
            install(args.uid, args.copilot)
        else:
            value = record()
            if args.action == "uninstall":
                uninstall(value, partial=value["phase"] == "installing")
            elif args.action == "upgrade-launcher":
                upgrade_launcher(value)
            elif args.action == "boot":
                check_files(value)
                configure_group(value["config"])
            elif args.action in ("enable", "disable"):
                set_enabled(value, args.action == "enable")
            else:
                check_files(value)
                if value["config"]["enabled"]:
                    common.verify_boundary(common.read_group())
                    systemctl("is-enabled", SETUP, TIMER)
                    systemctl("is-active", TIMER, common.WORKLOAD)
                elif common.GROUP.exists() and common.read_group()["limit"] < common.memory_info()[0]:
                    raise RuntimeError("Protection is marked disabled but a kernel ceiling is still present")
                print(json_report(value["config"]))
    if args.action in ("install", "enable"):
        systemctl("start", MONITOR)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("cpgctl: " + str(error), file=sys.stderr)
        sys.exit(1)
