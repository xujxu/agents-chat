#!/usr/bin/env python3
"""Read-only, external cgroup-v1 sampler; Python 3.8 standard library only."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

import cpg_common as common
from memory_sampler_metrics import (
    HIGH_INTERVAL, NORMAL_INTERVAL, READ_ERRORS, MemoryDetails, error_details, process_stat,
)
from memory_sampler_runtime import RuntimeCollector

PROC = Path("/proc")
INTERVAL = 10
SAMPLES = 720
WARN_BYTES = 1126 * common.MIB
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def boot_id():
    return (PROC / "sys/kernel/random/boot_id").read_text().strip()


def protected(membership):
    return membership == "/cpg.slice" or membership.startswith("/cpg.slice/")


def ensure_outside():
    if protected(common.memory_membership((PROC / "self" / "cgroup").read_text())):
        raise RuntimeError("Run the sampler outside /cpg.slice in a separate ordinary SSH shell")


def start_ticks(pid):
    return process_stat(PROC, pid)["start_ticks"]


def process_sample(pid):
    result = {"pid": pid}
    try:
        result.update(process_stat(PROC, pid))
        values = {}
        wanted = {
            "PPid": ("ppid", 1), "VmRSS": ("rss_bytes", 1024),
            "RssAnon": ("anonymous_bytes", 1024), "RssFile": ("file_bytes", 1024),
            "VmHWM": ("peak_rss_bytes", 1024), "VmSwap": ("swap_bytes", 1024),
            "Threads": ("threads", 1),
            "VmSize": ("virtual_bytes", 1024), "VmData": ("data_virtual_bytes", 1024),
            "VmStk": ("stack_virtual_bytes", 1024), "VmPTE": ("page_table_bytes", 1024),
            "RssShmem": ("shared_memory_bytes", 1024),
        }
        for line in (PROC / str(pid) / "status").read_text().splitlines():
            name, _, value = line.partition(":")
            if name in wanted:
                field, scale = wanted[name]
                values[field] = int(value.split()[0]) * scale
        errors = []
        for field, _ in wanted.values():
            if field not in values:
                values[field] = None
                errors.append({"operation": "read_status_field", "field": field,
                               "kind": "MissingField", "errno": None})
        membership = common.memory_membership((PROC / str(pid) / "cgroup").read_text())
        is_copilot = None
        try:
            basename = Path(os.readlink(str(PROC / str(pid) / "exe"))).name
            is_copilot = basename in ("copilot", "copilot (deleted)")
        except OSError as error:
            errors.append(error_details(error, "read_executable_basename"))
        if start_ticks(pid) != result["start_ticks"]:
            return dict(result, status="pid_reused_during_sample")
        if not protected(membership):
            return dict(result, status="left_group_during_sample")
        return dict(result, status="ok", is_copilot=is_copilot, errors=errors, **values)
    except FileNotFoundError:
        return dict(result, status="exited_during_sample")


def snapshot(label):
    group = common.read_group()
    common.verify_boundary(group)
    memory = common.counters(common.GROUP / "memory.stat")
    group.update({key: memory[key] for key in (
        "total_cache", "total_rss", "total_pgfault", "total_pgmajfault",
    )})
    available = common.counters(PROC / "meminfo")["MemAvailable"] * 1024
    processes = []
    for pid in common.group_pids():
        try:
            processes.append(process_sample(pid))
        except READ_ERRORS as error:
            processes.append({"pid": pid, "status": "read_error",
                              "error": error_details(error, "read_process")})
    return {"type": "sample", "schema": 2, "clock_ticks_per_second": CLOCK_TICKS,
            "time": timestamp(), "label": label,
            "group": group, "host_available_bytes": available, "processes": processes}


class ProcessHistory:
    def __init__(self):
        self.previous = {}

    def update(self, row):
        events = []
        current = {}
        observed = set()
        for process in row["processes"]:
            pid = process["pid"]
            observed.add(pid)
            if process["status"] != "ok":
                if pid in self.previous:
                    current[pid] = self.previous[pid]
                continue
            ticks = process["start_ticks"]
            current[pid] = ticks
            previous = self.previous.get(pid)
            if previous is None:
                events.append({"event": "process_seen", "pid": pid, "start_ticks": ticks})
            elif previous != ticks:
                events.append({"event": "pid_reused", "pid": pid,
                               "previous_start_ticks": previous, "start_ticks": ticks})
        for pid, previous in self.previous.items():
            if pid in observed:
                continue
            event = {"pid": pid, "start_ticks": previous}
            try:
                ticks = start_ticks(pid)
                if ticks != previous:
                    event.update(event="pid_reused", previous_start_ticks=previous,
                                 start_ticks=ticks)
                else:
                    membership = common.memory_membership(
                        (PROC / str(pid) / "cgroup").read_text())
                    if protected(membership):
                        event["event"] = "not_enumerated"
                        current[pid] = previous
                    else:
                        event["event"] = "left_group"
            except FileNotFoundError:
                event["event"] = "exited"
            except READ_ERRORS as error:
                event.update(event="read_error", error=error_details(error, "check_departure"))
                current[pid] = previous
            events.append(event)
        self.previous = current
        return events


class Alerts:
    def __init__(self):
        self.high = False
        self.last_warning = None
        self.oom_kills = None

    def update(self, row, now):
        group = row["group"]
        messages = []
        high = group["usage"] >= WARN_BYTES
        if high and (self.last_warning is None or now - self.last_warning >= 60):
            messages.append("HIGH_MEMORY charged_bytes={} limit_bytes={}".format(
                group["usage"], group["limit"]))
            self.last_warning = now
        if self.high and not high:
            messages.append("RECOVERED charged_bytes={}".format(group["usage"]))
        self.high = high
        kills = group["oom_kills"]
        if self.oom_kills is not None and kills != self.oom_kills:
            change = "INCREASE" if kills > self.oom_kills else "DECREASE"
            messages.append("OOM_COUNTER_{} previous={} current={}".format(
                change, self.oom_kills, kills))
        self.oom_kills = kills
        return messages


class SamplingPace:
    def __init__(self):
        self.previous = None
        self.burst_until = 0

    def update(self, row, now):
        usage = row["group"]["usage"]
        if usage >= WARN_BYTES or (
                self.previous is not None and usage - self.previous >= 128 * common.MIB):
            self.burst_until = now + 60
        self.previous = usage
        return 0.5 if now < self.burst_until else 2


class Log:
    def __init__(self, output, max_bytes=4 * common.MIB, backups=3):
        if max_bytes <= 0 or backups < 0:
            raise ValueError("Invalid log bounds")
        self.output = Path(output)
        self.max_bytes = max_bytes
        self.backups = backups
        self.directory = None
        self.lock = None
        self.stream = None

    def _directory(self):
        path = self.output.absolute()
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            for index, part in enumerate(path.parts[1:]):
                if part == "..":
                    raise RuntimeError("Output must not contain parent traversal")
                if index == len(path.parts) - 2:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                info = os.stat(part, dir_fd=descriptor, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    raise RuntimeError("Refusing symlink output directory")
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            info = os.fstat(descriptor)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise RuntimeError("Output must be an owned directory with mode 0700")
            self.directory = descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def _validate_file(self, info):
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError("Refusing symlink output file")
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600):
            raise RuntimeError("Output must be an owned single-link regular file with mode 0600")

    def _check(self, name):
        try:
            info = os.stat(name, dir_fd=self.directory, follow_symlinks=False)
        except FileNotFoundError:
            return
        self._validate_file(info)
        if name != ".lock" and info.st_size > self.max_bytes:
            raise RuntimeError("Existing log exceeds size bound; use a new output directory")

    def _open(self, name):
        self._check(name)
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_APPEND
                             | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.directory)
        try:
            self._validate_file(os.fstat(descriptor))
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor

    def __enter__(self):
        try:
            self._directory()
            self.lock = self._open(".lock")
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for name in os.listdir(self.directory):
                if name == "samples.jsonl" or name.startswith("samples.jsonl."):
                    self._check(name)
                    if name != "samples.jsonl" and name not in {
                        "samples.jsonl." + str(index) for index in range(1, self.backups + 1)
                    }:
                        raise RuntimeError("Unexpected log backup; use a new output directory")
            self.stream = os.fdopen(self._open("samples.jsonl"), "ab")
            self._repair_tail()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def _rotate(self):
        self.stream.close()
        self.stream = None
        names = ["samples.jsonl"] + [
            "samples.jsonl." + str(index) for index in range(1, self.backups + 1)]
        for name in names:
            self._check(name)
        try:
            os.unlink(names[-1], dir_fd=self.directory)
        except FileNotFoundError:
            pass
        for index in range(len(names) - 2, -1, -1):
            try:
                os.replace(names[index], names[index + 1],
                           src_dir_fd=self.directory, dst_dir_fd=self.directory)
            except FileNotFoundError:
                continue
        self.stream = os.fdopen(self._open("samples.jsonl"), "ab")

    @staticmethod
    def encode(row):
        return (json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")

    def _reader(self, name):
        self._check(name)
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=self.directory)
        try:
            self._validate_file(os.fstat(descriptor))
            return os.fdopen(descriptor, "rb")
        except BaseException:
            os.close(descriptor)
            raise

    def _repair_tail(self):
        with self._reader("samples.jsonl") as reader:
            end = reader.seek(0, os.SEEK_END)
            original = end
            while end:
                begin = max(0, end - 4096)
                reader.seek(begin)
                block = reader.read(end - begin)
                newline = block.rfind(b"\n")
                if newline >= 0:
                    end = begin + newline + 1
                    break
                end = begin
            if end != original:
                os.ftruncate(self.stream.fileno(), end)
                print("RECOVERED_INCOMPLETE_RECORD: discarded {} trailing bytes".format(
                    original - end), file=sys.stderr, flush=True)

    def records(self):
        names = ["samples.jsonl." + str(index) for index in range(self.backups, 0, -1)]
        for name in names + ["samples.jsonl"]:
            try:
                reader = self._reader(name)
            except FileNotFoundError:
                continue
            with reader:
                for line in reader:
                    yield json.loads(line)

    def evidence(self, name, data, replace=False):
        if name not in ("oom-before.jsonl", "oom-after.jsonl"):
            raise ValueError("Invalid evidence filename")
        descriptor = self._open(name)
        with os.fdopen(descriptor, "ab") as stream:
            size = 0 if replace else os.fstat(stream.fileno()).st_size
            if size + len(data) > self.max_bytes:
                return False
            if replace:
                os.ftruncate(stream.fileno(), 0)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        return True

    def write(self, row):
        data = self.encode(row)
        if len(data) > self.max_bytes:
            raise ValueError("Single record exceeds log size bound")
        if os.fstat(self.stream.fileno()).st_size + len(data) > self.max_bytes:
            self._rotate()
        self.stream.write(data)
        self.stream.flush()
        if row.get("runtime", {}).get("samples"):
            os.fsync(self.stream.fileno())

    def prepare_console(self):
        os.close(self._open("console.log"))

    def __exit__(self, *args):
        try:
            if self.stream is not None:
                self.stream.close()
        finally:
            self.stream = None
            if self.lock is not None:
                os.close(self.lock)
                self.lock = None
            if self.directory is not None:
                os.close(self.directory)
                self.directory = None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path,
                        help="New/private directory under an existing non-symlink parent")
    parser.add_argument("--label", default="new-session",
                        help="Non-sensitive comparison label, 1-48 ASCII letters/digits/_/-")
    parser.add_argument("--continuous", action="store_true",
                        help="Sample every 2 seconds without a deadline; retain latest OOM evidence")
    parser.add_argument("--runtime-socket", type=Path,
                        help="Private Unix socket for opt-in CLI numeric telemetry")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", args.label):
        parser.error("--label must contain only 1-48 ASCII letters/digits/_/-")
    try:
        ensure_outside()
        with Log(args.output) as log, RuntimeCollector(args.runtime_socket) as runtime:
            interval = 2 if args.continuous else INTERVAL
            duration = None if args.continuous else SAMPLES * INTERVAL
            boot = boot_id() if args.continuous else None
            incident = None
            if args.continuous:
                from memory_sampler_incident import IncidentCapture
                incident = IncidentCapture(log, boot)
            log.write({"type": "start", "time": timestamp(), "label": args.label,
                       "interval_seconds": interval, "duration_seconds": duration,
                       "warning_bytes": WARN_BYTES, "schema": 2,
                       "memory_detail_intervals_seconds": {
                           "normal": NORMAL_INTERVAL, "high": HIGH_INTERVAL,
                       }, "runtime_enabled": args.runtime_socket is not None,
                       "burst_interval_seconds": 0.5 if args.continuous else None})
            print("Sampling outside cpg: every {} seconds, {}. "
                  "Ctrl-C or systemctl stop stops cleanly.".format(
                      interval, "continuous" if args.continuous else "at most 2 hours"), flush=True)
            alerts = Alerts()
            history = ProcessHistory()
            memory_details = MemoryDetails(PROC, WARN_BYTES)
            pace = SamplingPace()
            deadline = None if args.continuous else time.monotonic() + duration
            reason = "duration_complete"
            result = 0
            try:
                index = 0
                while args.continuous or index < SAMPLES:
                    now = time.monotonic()
                    if deadline is not None and now >= deadline:
                        break
                    started = time.perf_counter()
                    row = snapshot(args.label)
                    row["monotonic_seconds"] = now
                    memory_details.update(row, now)
                    row["sample_duration_ms"] = round(
                        (time.perf_counter() - started) * 1000, 3)
                    row["events"] = history.update(row)
                    row["alerts"] = alerts.update(row, now)
                    row["runtime"] = runtime.take()
                    if row["runtime"]["rejected"] or row["runtime"]["dropped"]:
                        row["alerts"].append("RUNTIME_DATA_INCOMPLETE: rejected={} dropped={}".format(
                            row["runtime"]["rejected"], row["runtime"]["dropped"]))
                    if args.continuous:
                        interval = pace.update(row, now)
                    row["next_interval_seconds"] = interval
                    if incident is not None:
                        row["boot_id"] = boot
                        incident.observe(row, now)
                    log.write(row)
                    for alert in row["alerts"]:
                        print(row["time"] + " " + alert, file=sys.stderr, flush=True)
                    if any(p["status"] == "read_error" or p.get("errors")
                           for p in row["processes"]) or any(
                            event["event"] == "read_error" for event in row["events"]):
                        print("READ_ERROR: partial process data; see numeric log.",
                              file=sys.stderr, flush=True)
                    index += 1
                    remaining = interval if deadline is None else deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    if args.continuous or index < SAMPLES:
                        runtime.wait(min(interval, remaining))
            except KeyboardInterrupt:
                reason = "interrupted"
            except READ_ERRORS as error:
                reason = "read_error"
                result = 1
                details = error_details(error, "sample_or_write")
                log.write({"type": "error", "time": timestamp(), "error": details})
                print("SAMPLER_ERROR " + json.dumps(details), file=sys.stderr, flush=True)
            log.write({"type": "stop", "time": timestamp(), "reason": reason})
            print("Sampler stopped: " + reason, flush=True)
            return result
    except READ_ERRORS as error:
        print("SAMPLER_ERROR " + json.dumps(error_details(error, "startup_or_log"))
              + "; run outside /cpg.slice; use a private non-symlink output "
              "directory and only one writer.", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
