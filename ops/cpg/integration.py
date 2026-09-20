"""Run only inside a disposable GitHub Actions VM with legacy memory cgroups."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
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


def main():
    assert Path("/sys/fs/cgroup/memory/memory.limit_in_bytes").exists(), "VM did not boot cgroup v1"
    command("useradd", "--uid", "1001", "--create-home", "cpgtest")
    fixture = SOURCE / "fake_copilot.py"
    fixture.chmod(0o755)
    baseline = Path("/proc/self/cgroup").read_text()
    command("python3", str(SOURCE / "cpg_admin.py"), "install", "--uid", "1001", "--copilot", str(fixture))
    ctl("status")
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
    assert common.memory_membership(observed["group"]) == "/cpg-cli"
    assert common.memory_membership(observed["child_group"]) == "/cpg-cli"
    assert not common.memory_membership(user("/bin/cat", "/proc/self/cgroup").stdout).startswith("/cpg-cli")
    # The delegated join file must not allow changing the hard boundary.
    assert user("/bin/sh", "-c", "echo -1 > /sys/fs/cgroup/memory/cpg-cli/memory.limit_in_bytes", check=False).returncode != 0
    print("PASS: literal argv, --yolo, cwd, environment, identity and descendant boundary", flush=True)

    held = subprocess.Popen(
        ["runuser", "-u", "cpgtest", "--", "/usr/local/bin/cpg", "--hold"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    assert held.stdout.readline().strip() == "READY"
    refusal = ctl("uninstall", check=False)
    assert refusal.returncode != 0 and "running" in refusal.stderr
    ctl("disable")
    assert held.poll() is None, "disable killed an existing task"
    assert common.read_group()["limit"] > common.LIMIT
    disabled = user("/usr/local/bin/cpg", "--yolo")
    assert "DISABLED" in disabled.stderr
    assert common.memory_membership(json.loads(disabled.stdout)["group"]) != "/cpg-cli"
    ctl("enable")
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
    common.GROUP.rmdir()
    ctl("enable")
    ctl("status")
    ctl("uninstall")
    assert not common.GROUP.exists()
    for path in ("/usr/local/bin/cpg", "/usr/local/sbin/cpgctl", "/etc/cpg/config.json",
                 "/etc/systemd/system/cpg-setup.service", "/etc/systemd/system/cpg-monitor.timer"):
        assert not Path(path).exists(), path
    assert Path("/proc/self/cgroup").read_text() == baseline
    print("PASS: persistent setup and clean standalone uninstall", flush=True)


if __name__ == "__main__":
    main()
