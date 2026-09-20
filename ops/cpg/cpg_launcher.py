#!/usr/bin/python3 -I
"""Launch the configured Copilot without changing its arguments or privileges."""
import os
from pathlib import Path
import signal
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, "/usr/local/libexec/cpg")
import cpg_common as common


def run(config, arguments):
    if os.getuid() == 0 or os.getuid() != config["uid"]:
        raise RuntimeError("cpg must run as its configured ordinary user, never root")
    executable = config["executable"]
    if not config["enabled"]:
        print("CPG DISABLED: launching Copilot without memory protection.", file=sys.stderr, flush=True)
        os.execv(executable, [executable] + arguments)
        return
    common.verify_boundary(common.read_group())
    _, available = common.memory_info()
    group = common.read_group()
    if available < 512 * common.MIB or group["usage"] >= common.LIMIT - 128 * common.MIB:
        raise RuntimeError("Insufficient headroom for another protected CLI; close existing tasks first")
    membership = common.memory_membership(Path("/proc/self/cgroup").read_text())
    if membership == "/cpg.slice" or membership.startswith("/cpg.slice/"):
        raise RuntimeError("Already inside cpg; run the original Copilot rather than nesting supervisors")
    ready_read, ready_write = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(ready_read)
        try:
            subprocess.run(
                ["/usr/bin/busctl", "--system", "--quiet", "call", "org.freedesktop.systemd1",
                 "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
                 "AttachProcessesToUnit", "ssau", common.WORKLOAD, "", "1", str(os.getpid())],
                env={"PATH": "/usr/bin:/bin", "LANG": "C"},
                check=True, capture_output=True, text=True, timeout=10,
            )
            if common.memory_membership(Path("/proc/self/cgroup").read_text()) != common.WORKLOAD_PATH:
                raise RuntimeError("Kernel did not move Copilot into its private memory group")
            common.verify_boundary(common.read_group())
            os.write(ready_write, b"ready")
            os.close(ready_write)
            os.execv(executable, [executable] + arguments)
        except Exception as error:
            print("cpg: protected launch failed: " + str(error), file=sys.stderr, flush=True)
            os._exit(125)
    os.close(ready_write)
    try:
        os.read(ready_read, 5)
    finally:
        os.close(ready_read)
    return child, group


def supervise(child, before):
    def forward(number, frame):
        try:
            os.kill(child, number)
        except ProcessLookupError:
            pass

    for number in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, forward)
    for number in (signal.SIGINT, signal.SIGQUIT):
        signal.signal(number, signal.SIG_IGN if sys.stdin.isatty() else forward)
    _, status = os.waitpid(child, 0)
    code = 128 + os.WTERMSIG(status) if os.WIFSIGNALED(status) else os.WEXITSTATUS(status)
    if common.LOCK.exists():
        with common.locked():
            if common.GROUP.exists():
                after = common.read_group()
                if code == 137 and after["oom_kills"] > before["oom_kills"]:
                    print("cpg: kernel OOM in protected Copilot group (1536 MiB shared ceiling). "
                          "Your shell is outside this group.", file=sys.stderr)
                elif code and after["failcnt"] > before["failcnt"]:
                    print("cpg: memory ceiling was reached during this run; exit code " + str(code),
                          file=sys.stderr)
    else:
        print("cpg: guard was uninstalled after task exit; returning original exit status.", file=sys.stderr)
    return code


def main():
    with common.locked():
        result = run(common.load_config(), sys.argv[1:])
    child, before = result
    return supervise(child, before)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("cpg: " + str(error) + "; no unprotected fallback was started.", file=sys.stderr)
        sys.exit(125)
