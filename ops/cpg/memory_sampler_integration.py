"""Run only inside the disposable Actions Ubuntu 20.04/cgroup-v1 VM."""
import json
from pathlib import Path
import subprocess
import time

import cpg_common as common
import memory_sampler_service as service

SOURCE = Path(__file__).resolve().parent
OUTPUT = service.output_directory(1001)
UNIT = service.unit_name(1001)


def command(*args, check=True):
    result = subprocess.run(args, text=True, capture_output=True, timeout=120)
    if check and result.returncode:
        raise AssertionError("{}: {} {}".format(args[0], result.stdout, result.stderr))
    return result


def show(*names):
    result = command("systemctl", "show", UNIT, *["--property=" + name for name in names])
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def wait_for(predicate, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.25)
    raise AssertionError("Timed out waiting for sampler state")


def rows():
    return [json.loads(line) for line in (OUTPUT / "samples.jsonl").read_text().splitlines()]


def main():
    assert common.CONTROLLER.exists(), "Requires the disposable legacy-cgroup VM"
    assert "245" in command("systemctl", "--version").stdout.splitlines()[0]
    command("useradd", "--uid", "1001", "--create-home", "samplertest")
    command("systemctl", "set-property", "--runtime", "cpg.slice", "MemoryMax=1536M")
    command("systemd-run", "--unit=sampler-fixture", "--slice=cpg.slice",
            "--property=User=1001", "/bin/sleep", "180")
    common.verify_boundary(common.read_group())
    before = common.read_group()
    command("runuser", "-u", "samplertest", "--", "/usr/bin/python3", "-B", "-c",
            "import sys; sys.path.insert(0, '/opt/cpg-test'); "
            "import memory_sampler_service as s; s.prepare_output(s.output_directory(1001))")

    original = service.start_command(SOURCE, OUTPUT, 1001, 1001)
    assert "--property=RuntimeMaxSec=7200" in original
    timed = ["--property=RuntimeMaxSec=25" if item == "--property=RuntimeMaxSec=7200"
             else item for item in original]
    started = time.monotonic()
    command(*timed)
    wait_for(lambda: (OUTPUT / "samples.jsonl").stat().st_size > 0)
    wait_for(lambda: any(row["type"] == "sample" for row in rows()))
    state = show("MainPID", "ControlGroup", "MemoryMax", "TasksMax",
                 "CPUQuotaPerSecUSec", "Restart", "RuntimeMaxUSec", "ActiveState")
    assert state["ActiveState"] == "active", (state, (OUTPUT / "console.log").read_text())
    pid = int(state["MainPID"])
    membership = common.memory_membership(Path("/proc/{}/cgroup".format(pid)).read_text())
    assert membership == "/system.slice/" + UNIT, membership
    status = Path("/proc/{}/status".format(pid)).read_text()
    assert next(line for line in status.splitlines() if line.startswith("Uid:")).split()[1:] == ["1001"] * 4
    assert state["MemoryMax"] == str(32 * common.MIB)
    assert state["TasksMax"] == "8" and state["CPUQuotaPerSecUSec"] == "50ms"
    assert state["Restart"] == "no"
    assert state["RuntimeMaxUSec"] == "25s"
    group = common.CONTROLLER / membership.lstrip("/")
    assert int((group / "memory.limit_in_bytes").read_text()) == 32 * common.MIB
    cpu = Path("/sys/fs/cgroup/cpu,cpuacct") / membership.lstrip("/")
    assert int((cpu / "cpu.cfs_quota_us").read_text()) * 20 == int((cpu / "cpu.cfs_period_us").read_text())
    pids = Path("/sys/fs/cgroup/pids") / membership.lstrip("/")
    assert (pids / "pids.max").read_text().strip() == "8"
    peak = int((group / "memory.max_usage_in_bytes").read_text())
    cpu_ns = 0
    while show("ActiveState")["ActiveState"] in ("active", "deactivating"):
        assert time.monotonic() - started < 45, "Runtime watchdog exceeded grace period"
        if group.exists():
            try:
                peak = max(peak, int((group / "memory.max_usage_in_bytes").read_text()))
                cpu_ns = max(cpu_ns, int((cpu / "cpuacct.usage").read_text()))
            except FileNotFoundError:
                pass
        time.sleep(0.25)
    state = show("Result", "NRestarts")
    assert state["Result"] == "timeout" and state["NRestarts"] == "0", state
    elapsed = time.monotonic() - started
    assert 25 <= elapsed < 45, elapsed
    records = rows()
    samples = [row for row in records if row["type"] == "sample"]
    assert len(samples) >= 2, records
    assert records[-1]["reason"] == "interrupted", records[-1]
    assert all(row["group"]["limit"] == common.LIMIT for row in samples)
    assert all(row["processes"] for row in samples)
    assert all(process["status"] == "ok" and not process["errors"]
               for row in samples for process in row["processes"])
    assert peak < 32 * common.MIB and cpu_ns < 2_000_000_000, (peak, cpu_ns)
    after = common.read_group()
    assert after["limit"] == before["limit"] and after["oom_kills"] == before["oom_kills"]
    print("PASS: real v1 service, non-root, outside cpg; peak_bytes={} cpu_ns={} "
          "elapsed_seconds={:.2f} samples={}".format(peak, cpu_ns, elapsed, len(samples)), flush=True)

    command("systemctl", "reset-failed", UNIT)
    previous = len(samples)
    command(*original)
    wait_for(lambda: len([row for row in rows() if row["type"] == "sample"]) > previous)
    command("systemctl", "stop", UNIT)
    assert rows()[-1]["reason"] == "interrupted"
    assert len([row for row in rows() if row["type"] == "sample"]) > previous
    print("PASS: manual stop is graceful; restart reuses logs without deleting evidence", flush=True)

    probe = original[:original.index("--") + 1] + [
        "/usr/bin/python3", "-B", "-c",
        "import errno, os, resource, signal; from pathlib import Path; "
        "assert resource.getrlimit(resource.RLIMIT_FSIZE) == (4194304, 4194304); "
        "signal.signal(signal.SIGXFSZ, signal.SIG_IGN); "
        "p=Path('/tmp/cli-memory-sampler-1001/size-probe'); "
        "fd=os.open(str(p), os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600); "
        "os.lseek(fd, 4194304, os.SEEK_SET)\n"
        "try:\n os.write(fd, b'x')\n raise AssertionError('file limit not enforced')\n"
        "except OSError as e:\n assert e.errno == errno.EFBIG\n"
        "finally:\n os.close(fd)\n p.unlink()\n"
        "print('FILE_LIMIT_VERIFIED', flush=True)\n",
    ]
    probe.insert(1, "--wait")
    command(*probe)
    assert "FILE_LIMIT_VERIFIED" in (OUTPUT / "console.log").read_text()
    assert OUTPUT.stat().st_mode & 0o777 == 0o700
    files = list(OUTPUT.iterdir())
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in files)
    assert all(path.stat().st_size <= 4 * common.MIB for path in files)
    assert sum(path.stat().st_size for path in files) <= 20 * common.MIB
    assert not Path("/var/lib/systemd/linger/samplertest").exists()
    assert not Path("/etc/systemd/system/" + UNIT).exists()
    print("PASS: kernel file-size cap, private bounded logs; no linger or persistent unit", flush=True)
    persistent()


def persistent():
    global OUTPUT
    OUTPUT = Path("/var/lib/cli-memory-sampler-1001")
    Path("/etc/systemd/system/cpg-setup.service").write_text(
        "[Service]\nType=oneshot\nExecStart=/bin/true\nRemainAfterExit=yes\n")
    command("systemctl", "daemon-reload")
    command("/usr/bin/python3", "-B", str(SOURCE / "memory_sampler_service.py"),
            "--install", "--uid", "1001")
    wait_for(lambda: (OUTPUT / "samples.jsonl").exists())
    wait_for(lambda: any(row["type"] == "sample" for row in rows()))
    state = show("MainPID", "ControlGroup", "RuntimeMaxUSec", "Restart", "MemoryMax")
    assert state["RuntimeMaxUSec"] == "infinity" and state["Restart"] == "on-failure", state
    assert state["ControlGroup"] == "/system.slice/" + UNIT, state
    assert state["MemoryMax"] == str(32 * common.MIB)
    command("systemctl", "is-enabled", "--quiet", UNIT)
    assert Path("/etc/systemd/system/" + UNIT).exists()
    assert Path("/etc/systemd/system/multi-user.target.wants/" + UNIT).is_symlink()
    assert OUTPUT.stat().st_uid == 1001 and OUTPUT.stat().st_mode & 0o777 == 0o700
    assert rows()[0]["interval_seconds"] == 2 and rows()[0]["duration_seconds"] is None
    first_pid = int(state["MainPID"])
    first_samples = len([row for row in rows() if row["type"] == "sample"])
    command("systemctl", "kill", "--signal=SIGKILL", "--kill-who=main", UNIT)
    wait_for(lambda: int(show("MainPID")["MainPID"]) not in (0, first_pid), seconds=50)
    wait_for(lambda: len([row for row in rows() if row["type"] == "sample"]) > first_samples)
    print("PASS: installed boot-enabled service; restart after abrupt sampler exit preserves logs",
          flush=True)

    # Only the disposable VM creates pressure, in a small child group with a surviving parent.
    oom_script = (
        "import subprocess, time; time.sleep(3); "
        "r=subprocess.run(['/usr/bin/python3','-c','x=bytearray(80*1024*1024)']); "
        "print('victim_returncode='+str(r.returncode), flush=True); time.sleep(90)"
    )
    previous_kills = common.read_group()["oom_kills"]
    command("systemd-run", "--unit=sampler-oom-fixture", "--slice=cpg.slice",
            "--property=MemoryMax=48M", "--property=OOMPolicy=continue",
            "/usr/bin/python3", "-c", oom_script)
    wait_for(lambda: common.read_group()["oom_kills"] > previous_kills)
    wait_for(lambda: (OUTPUT / "oom-before.jsonl").exists())
    before = [json.loads(line) for line in (OUTPUT / "oom-before.jsonl").read_text().splitlines()]
    assert before[-1]["incident"]["previous_oom_kills"] == previous_kills
    assert before[-1]["incident"]["oom_kills"] > previous_kills
    command("systemctl", "is-active", "--quiet", UNIT)
    wait_for(lambda: len((OUTPUT / "oom-after.jsonl").read_text().splitlines()) >= 3)
    print("PASS: sampler outside protected group survives real fixture OOM and saves pre/post evidence",
          flush=True)
    evidence = (OUTPUT / "oom-before.jsonl").read_bytes()
    command("systemctl", "stop", "sampler-oom-fixture.service")
    command("systemctl", "restart", UNIT)
    wait_for(lambda: rows()[-1]["type"] == "sample")
    assert (OUTPUT / "oom-before.jsonl").read_bytes() == evidence
    command("systemctl", "stop", UNIT)
    assert rows()[-1]["reason"] == "interrupted"
    for path in OUTPUT.glob("*.jsonl*"):
        assert path.stat().st_size <= 4 * common.MIB
        assert path.stat().st_mode & 0o777 == 0o600
    assert sum(path.stat().st_size for path in OUTPUT.glob("*.jsonl*")) <= 24 * common.MIB
    assert not (OUTPUT / "console.log").exists()
    assert not Path("/var/lib/systemd/linger/samplertest").exists()
    print("PASS: manual restart/stop preserves latest incident, 24 MiB data bound, no console growth",
          flush=True)


if __name__ == "__main__":
    main()
