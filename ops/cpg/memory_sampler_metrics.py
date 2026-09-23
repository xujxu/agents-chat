"""Numeric proc counters and rate-limited memory breakdowns; no heap inspection."""
import time

import cpg_common as common

READ_ERRORS = (OSError, ValueError, KeyError, RuntimeError)
NORMAL_INTERVAL = 60
HIGH_INTERVAL = 30


def error_details(error, operation):
    # Exception messages can contain paths or file contents.
    return {"operation": operation, "kind": type(error).__name__,
            "errno": error.errno if isinstance(error, OSError) else None}


def process_stat(proc, pid):
    text = (proc / str(pid) / "stat").read_text()
    # The comm field may contain spaces and closing parentheses.
    fields = text[text.rindex(")") + 1:].split()
    if len(fields) < 20:
        raise ValueError("Incomplete process stat")
    return {name: int(fields[index]) for name, index in (
        ("start_ticks", 19), ("minor_faults", 7), ("major_faults", 9),
        ("cpu_user_ticks", 11), ("cpu_system_ticks", 12),
    )}


def read_rollup(path):
    required = {
        "Rss": "rss_bytes", "Pss": "pss_bytes",
        "Shared_Clean": "shared_clean_bytes", "Shared_Dirty": "shared_dirty_bytes",
        "Private_Clean": "private_clean_bytes", "Private_Dirty": "private_dirty_bytes",
        "Anonymous": "anonymous_bytes", "Swap": "swap_bytes",
    }
    optional = {
        "Pss_Anon": "pss_anon_bytes", "Pss_File": "pss_file_bytes",
        "Pss_Shmem": "pss_shmem_bytes", "AnonHugePages": "anonymous_huge_page_bytes",
        "LazyFree": "lazy_free_bytes", "SwapPss": "swap_pss_bytes",
    }
    wanted = dict(required, **optional)
    values = {}
    with path.open() as stream:
        for line in stream:
            name, _, text = line.partition(":")
            if name in wanted:
                fields = text.split()
                if len(fields) != 2 or fields[1] != "kB":
                    raise ValueError("Invalid memory counter unit")
                value = int(fields[0])
                if value < 0:
                    raise ValueError("Negative memory counter")
                values[wanted[name]] = value * 1024
    for field in required.values():
        if field not in values:
            raise KeyError(field)
    missing = [field for field in optional.values() if field not in values]
    values.update({field: None for field in missing})
    values["unavailable_fields"] = missing
    return values


class MemoryDetails:
    def __init__(self, proc, warning_bytes):
        self.proc = proc
        self.warning_bytes = warning_bytes
        self.last_read = {}

    def _identity(self, process):
        pid = process["pid"]
        if process_stat(self.proc, pid)["start_ticks"] != process["start_ticks"]:
            return "pid_reused"
        membership = common.memory_membership(
            (self.proc / str(pid) / "cgroup").read_text())
        if membership != "/cpg.slice" and not membership.startswith("/cpg.slice/"):
            return "left_group"
        return None

    def _read(self, process):
        try:
            changed = self._identity(process)
            if changed:
                return {"status": changed}
            values = read_rollup(self.proc / str(process["pid"]) / "smaps_rollup")
            changed = self._identity(process)
            if changed:
                return {"status": changed}
            return dict(values, status="ok")
        except READ_ERRORS as error:
            details = error_details(error, "read_smaps_rollup")
            process["errors"].append(details)
            return {"status": "read_error", "error": details}

    def update(self, row, now):
        interval = HIGH_INTERVAL if row["group"]["usage"] >= self.warning_bytes else NORMAL_INTERVAL
        current = {}
        for process in row["processes"]:
            if process["status"] != "ok":
                continue
            if process["is_copilot"] is not True:
                process["memory_detail"] = {"status": "not_copilot"}
                continue
            key = (process["pid"], process["start_ticks"])
            previous = self.last_read.get(key)
            if previous is not None and now - previous < interval:
                current[key] = previous
                process["memory_detail"] = {"status": "not_due"}
                continue
            current[key] = now
            started = time.perf_counter()
            detail = self._read(process)
            detail["sampled_at"] = row["time"]
            detail["read_duration_ms"] = round((time.perf_counter() - started) * 1000, 3)
            process["memory_detail"] = detail
        self.last_read = current
