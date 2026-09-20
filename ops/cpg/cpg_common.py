"""Shared policy and cgroup-v1 I/O for the standalone terminal guard."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile

MIB = 1024 * 1024
LIMIT = 1536 * MIB
CONTROLLER = Path("/sys/fs/cgroup/memory")
GROUP = CONTROLLER / "cpg.slice"
WORKLOAD = "cpg-workload.service"
WORKLOAD_PATH = "/cpg.slice/" + WORKLOAD
CONFIG = Path("/etc/cpg/config.json")
STATE = Path("/var/lib/cpg")
RECORD = STATE / "installation.json"
LOCK = Path("/run/lock/cpg.lock")
LIB = Path("/usr/local/libexec/cpg")
LAUNCHER = Path("/usr/local/bin/cpg")
ADMIN = Path("/usr/local/sbin/cpgctl")


def read_json(path):
    return json.loads(path.read_text())


def write_bytes(path, data, mode=0o644):
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise RuntimeError("Refusing symlink target: " + str(path))
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(path))
        directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json(path, data, mode=0o644):
    write_bytes(path, (json.dumps(data, indent=2) + "\n").encode(), mode)


def validate_config(config):
    if (
        config.get("schema") != 1
        or type(config.get("uid")) is not int or config["uid"] <= 0
        or type(config.get("gid")) is not int or config["gid"] < 0
        or type(config.get("enabled")) is not bool
        or not isinstance(config.get("executable"), str)
        or not Path(config["executable"]).is_absolute()
    ):
        raise RuntimeError("Invalid cpg configuration")


def load_config():
    info = CONFIG.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("cpg configuration must be a root-owned, non-writable regular file")
    config = read_json(CONFIG)
    validate_config(config)
    return config


@contextmanager
def locked(exclusive=False, nonblocking=False):
    descriptor = os.open(str(LOCK), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("Unsafe cpg lifecycle lock")
        operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        fcntl.flock(descriptor, operation | (fcntl.LOCK_NB if nonblocking else 0))
        yield
    finally:
        os.close(descriptor)


def memory_membership(text):
    for line in text.splitlines():
        _, controllers, path = line.split(":", 2)
        if "memory" in controllers.split(","):
            return path
    raise RuntimeError("A cgroup-v1 memory controller is required")


def counters(path):
    result = {}
    for line in path.read_text().splitlines():
        parts = line.replace(":", "").split()
        if len(parts) > 1:
            result[parts[0]] = int(parts[1])
    return result


def memory_info():
    values = counters(Path("/proc/meminfo"))
    return values["MemTotal"] * 1024, values["MemAvailable"] * 1024


def group_pids():
    result = set()
    for path in GROUP.rglob("cgroup.procs"):
        try:
            result.update(int(pid) for pid in path.read_text().split())
        except FileNotFoundError:
            # A finished delegated subgroup may disappear during enumeration.
            continue
    return sorted(result)


def read_group():
    oom = counters(GROUP / "memory.oom_control")
    memory = counters(GROUP / "memory.stat")
    return {
        "limit": int((GROUP / "memory.limit_in_bytes").read_text()),
        "usage": int((GROUP / "memory.usage_in_bytes").read_text()),
        "inactive_file": memory["total_inactive_file"],
        "hierarchy": int((GROUP / "memory.use_hierarchy").read_text()),
        "oom_disabled": oom["oom_kill_disable"],
        "oom_kills": oom["oom_kill"],
        "failcnt": int((GROUP / "memory.failcnt").read_text()),
    }


def verify_boundary(group):
    if group["limit"] != LIMIT or group["hierarchy"] != 1 or group["oom_disabled"] != 0:
        raise RuntimeError("cpg kernel memory boundary is missing or changed")


def pressure_reasons(available, group):
    reasons = []
    if available < 256 * MIB:
        reasons.append("CRITICAL host available memory below 256 MiB")
    elif available < 512 * MIB:
        reasons.append("WARNING host available memory below 512 MiB")
    working_set = max(0, group["usage"] - group["inactive_file"])
    if working_set >= LIMIT * 95 // 100:
        reasons.append("CRITICAL protected CLI working set at least 95% of ceiling")
    elif working_set >= LIMIT * 80 // 100:
        reasons.append("WARNING protected CLI working set at least 80% of ceiling")
    return reasons
