"""Run only inside a disposable GitHub Actions VM with legacy memory cgroups."""
import json
import errno
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import termios
import time

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE))
import cpg_common as common


def command(*args, check=True, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=120, **kwargs)
    if check and result.returncode:
        raise AssertionError("{} failed: {} {}".format(args[0], result.stdout, result.stderr))
    return result


def user(*args, **kwargs):
    return command("runuser", "-u", "cpgtest", "--", *args, **kwargs)


def ctl(action, check=True):
    return command("/usr/local/sbin/cpgctl", action, check=check)


def terminal_run(arguments, interrupt=False):
    master, slave = pty.openpty()

    def become_user():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        os.setgroups([])
        os.setgid(1001)
        os.setuid(1001)

    process = subprocess.Popen(
        ["/usr/local/bin/cpg", *arguments], stdin=slave, stdout=slave, stderr=slave,
        preexec_fn=become_user,
    )
    os.close(slave)
    output = b""
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.2)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                output += chunk
                if interrupt and b"READY" in output:
                    os.write(master, b"\x03")
                    interrupt = False
            elif process.poll() is not None:
                break
        return process.wait(timeout=5), output.decode()
    finally:
        os.close(master)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)


def main():
    assert Path("/sys/fs/cgroup/memory/memory.limit_in_bytes").exists(), "VM did not boot cgroup v1"
    command("useradd", "--uid", "1001", "--create-home", "cpgtest")
    fixture = SOURCE / "fake_copilot.py"
    fixture.chmod(0o755)
    baseline = Path("/proc/self/cgroup").read_text()
    command("python3", str(SOURCE / "cpg_admin.py"), "install", "--uid", "1001", "--copilot", str(fixture))
    ctl("status")
    assert command("systemctl", "show", "cpg-monitor.service", "--property=Result", "--value").stdout.strip() == "success"
    assert common.read_group()["limit"] == 1610612736
    assert Path("/proc/self/cgroup").read_text() == baseline
    assert not Path("/etc/systemd/system/user-1001.slice.d/70-host-memory-guard.conf").exists()
    assert not Path("/etc/systemd/system/agents-chat.service.d/70-host-memory-guard.conf").exists()

    arguments = ["--yolo", "--model", "a b", "$(not-a-command)", ""]
    result = user("/usr/local/bin/cpg", *arguments, cwd="/tmp", env=dict(os.environ, CPG_TEST_MARKER="preserved"))
    observed = json.loads(result.stdout)
    assert observed["args"] == arguments
    assert observed["uid"] == 1001 and observed["cwd"] == "/tmp"
    assert observed["marker"] == "preserved"
    assert common.memory_membership(observed["group"]) == common.WORKLOAD_PATH
    assert common.memory_membership(observed["child_group"]) == common.WORKLOAD_PATH
    assert not common.memory_membership(observed["parent_group"]).startswith("/cpg.slice")
    assert not common.memory_membership(user("/bin/cat", "/proc/self/cgroup").stdout).startswith("/cpg.slice")
    # The delegated join file must not allow changing the hard boundary.
    assert user("/bin/sh", "-c", "echo -1 > /sys/fs/cgroup/memory/cpg.slice/memory.limit_in_bytes", check=False).returncode != 0
    print("PASS: literal argv, --yolo, cwd, environment, identity and descendant boundary", flush=True)
    code, text = terminal_run(["--yolo"])
    assert code == 0, (code, text)
    assert json.loads(text)["tty"] == [True, True, True]
    code, text = terminal_run(["--interruptible"], interrupt=True)
    assert code == 42, (code, text)
    print("PASS: interactive PTY descriptors and Ctrl-C forwarded without killing supervisor", flush=True)

    held = subprocess.Popen(
        ["runuser", "-u", "cpgtest", "--", "/usr/local/bin/cpg", "--hold"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    assert held.stdout.readline().strip() == "READY"
    protected = common.group_pids()
    assert protected, "held Copilot did not enter the protected group"
    print("Protected PIDs before lifecycle:", protected, flush=True)
    refusal = ctl("uninstall", check=False)
    assert refusal.returncode != 0 and "running" in refusal.stderr
    command("systemctl", "daemon-reload")
    for pid in protected:
        assert common.memory_membership(Path("/proc/{}/cgroup".format(pid)).read_text()) == common.WORKLOAD_PATH
    ctl("disable")
    print("Protected PIDs after disable:", common.group_pids(), flush=True)
    assert held.poll() is None, "disable killed an existing task"
    assert common.read_group()["limit"] > common.LIMIT
    disabled = user("/usr/local/bin/cpg", "--yolo")
    assert "DISABLED" in disabled.stderr
    assert not common.memory_membership(json.loads(disabled.stdout)["group"]).startswith("/cpg.slice")
    ctl("enable")
    print("Protected PIDs after enable:", common.group_pids(), flush=True)
    for pid in protected:
        print("Held membership:", pid, Path("/proc/{}/cgroup".format(pid)).read_text(), flush=True)
        assert common.memory_membership(Path("/proc/{}/cgroup".format(pid)).read_text()) == common.WORKLOAD_PATH
    assert held.poll() is None
    for pid in common.group_pids():
        os.kill(pid, signal.SIGTERM)
    held.communicate(timeout=20)
    print("PASS: live disable/enable and active-task uninstall refusal", flush=True)

    # A same-user unrelated process represents an SSH-side workload.
    sentinel = subprocess.Popen(["runuser", "-u", "cpgtest", "--", "/bin/sleep", "180"])
    try:
        before = common.read_group()["oom_kills"]
        result = user("/usr/local/bin/cpg", "--allocate", check=False)
        assert result.returncode == 137, (result.returncode, result.stderr)
        assert "OOM" in result.stderr
        assert common.read_group()["oom_kills"] > before
        assert sentinel.poll() is None, "unrelated same-user workload was killed"
        assert Path("/proc/self/cgroup").read_text() == baseline
        assert not common.group_pids(), "fixture left isolated tasks running"
    finally:
        sentinel.terminate()
        sentinel.wait(timeout=10)
    print("PASS: real 1536 MiB kernel OOM, supervisor and unrelated task survive", flush=True)

    # Verify persistent initialization recreates a missing empty group.
    ctl("disable")
    command("systemctl", "stop", common.WORKLOAD, "cpg.slice")
    assert not common.GROUP.exists()
    common.LOCK.unlink()
    command("systemctl", "start", "cpg-setup.service")
    assert common.LOCK.exists()
    assert common.read_group()["limit"] > common.LIMIT
    disabled = user("/usr/local/bin/cpg", "--yolo")
    assert "DISABLED" in disabled.stderr
    ctl("enable")
    ctl("status")
    # Neither drift nor a missing boundary may cause a silent unprotected launch.
    command("systemctl", "stop", common.WORKLOAD)
    failed = user("/usr/local/bin/cpg", "--yolo", check=False)
    assert failed.returncode == 125 and not failed.stdout
    command("systemctl", "start", common.WORKLOAD)
    (common.GROUP / "memory.limit_in_bytes").write_text("-1")
    failed = user("/usr/local/bin/cpg", "--yolo", check=False)
    assert failed.returncode == 125 and not failed.stdout
    (common.GROUP / "memory.limit_in_bytes").write_text(str(common.LIMIT))
    owned = common.LIB / "cpg_common.py"
    original = owned.read_bytes()
    owned.write_bytes(original + b"\n# drift fixture\n")
    refusal = ctl("uninstall", check=False)
    assert refusal.returncode != 0 and "modified" in refusal.stderr
    assert common.read_group()["limit"] == common.LIMIT
    owned.write_bytes(original)
    print("PASS: failed join/boundary fail closed and uninstall preserves modified files", flush=True)
    ctl("uninstall")
    assert not common.GROUP.exists()
    for path in ("/usr/local/bin/cpg", "/usr/local/sbin/cpgctl", "/etc/cpg/config.json",
                 "/etc/systemd/system/cpg-setup.service", "/etc/systemd/system/cpg-monitor.timer",
                 "/etc/systemd/system/cpg-workload.service", "/etc/systemd/system/cpg.slice",
                 "/usr/local/libexec/cpg", "/var/lib/cpg", "/run/lock/cpg.lock"):
        assert not Path(path).exists(), path
    assert Path("/proc/self/cgroup").read_text() == baseline
    print("PASS: persistent setup and clean standalone uninstall", flush=True)


if __name__ == "__main__":
    main()
