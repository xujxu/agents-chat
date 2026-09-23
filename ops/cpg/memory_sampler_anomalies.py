"""Bounded allocation episode detection and short external thread CPU windows."""
import os
import time

import cpg_common as common
from memory_sampler_metrics import MemoryDetails, READ_ERRORS, error_details, process_stat


class AllocationWatch:
    def __init__(self):
        self.previous = {}
        self.windows = {}

    def active(self, now):
        return {key for key, until in self.windows.items() if now < until}

    def update(self, row, now):
        observed = {(p["pid"], p["start_ticks"]) for p in row.get("processes", [])
                    if p.get("status") == "ok"}
        anomalies = []
        for entry in row.get("runtime", {}).get("samples", []):
            key = (entry["pid"], entry["start_ticks"])
            observed.add(key)
            metrics = entry["metrics"]
            sequence, value = metrics["sequence"], metrics["malloced_bytes"]
            previous = self.previous.get(key)
            if previous and sequence <= previous[0]:
                continue
            high = previous[2] if previous else False
            delta = value - previous[1] if previous else None
            trigger = value >= 64 * common.MIB or (
                delta is not None and delta >= 32 * common.MIB)
            if trigger and not high:
                anomalies.append({"pid": key[0], "start_ticks": key[1],
                                  "sequence": sequence, "malloced_bytes": value,
                                  "delta_bytes": delta})
                high = True
                self.windows[key] = now + 30
            if value < 32 * common.MIB:
                high = False
            self.previous[key] = (sequence, value, high)
        self.previous = {key: value for key, value in self.previous.items() if key in observed}
        self.windows = {key: until for key, until in self.windows.items()
                        if key in observed and now < until}
        row["allocation_anomalies"] = anomalies
        if anomalies:
            row["alerts"].append("V8_ALLOCATION_ANOMALY: see allocation_anomalies")


class ThreadDetails:
    MAX_THREADS = 64
    MAX_PROCESSES = 4

    def __init__(self, proc):
        self.proc = proc
        self.identity = MemoryDetails(proc, 0)
        self.previous = {}
        self.last_read = {}

    def _read(self, process, now):
        key = (process["pid"], process["start_ticks"])
        changed = self.identity._identity(process)
        if changed:
            self.previous.pop(key, None)
            return {"status": changed}
        task = self.proc / str(process["pid"]) / "task"
        threads, current = [], {}
        truncated = False
        with os.scandir(task) as entries:
            for entry in entries:
                if len(threads) >= self.MAX_THREADS:
                    truncated = True
                    break
                tid = int(entry.name)
                try:
                    text = (task / entry.name / "stat").read_text()
                    fields = text[text.rindex(")") + 1:].split()
                    start = int(fields[19])
                    user, system = int(fields[11]), int(fields[12])
                    name = text[text.index("(") + 1:text.rindex(")")][:64]
                    # A second identity read prevents attaching CPU deltas to reused TIDs.
                    if process_stat(task, tid)["start_ticks"] != start:
                        threads.append({"tid": tid, "status": "tid_reused"})
                        continue
                    prior = self.previous.get(key, {}).get((tid, start))
                    total = user + system
                    delta = total - prior[1] if prior else None
                    if delta is not None and delta < 0:
                        raise ValueError("Thread CPU counter decreased")
                    threads.append({"tid": tid, "start_ticks": start, "name": name,
                                    "status": "ok", "cpu_user_ticks": user,
                                    "cpu_system_ticks": system, "cpu_delta_ticks": delta,
                                    "elapsed_seconds": now - prior[0] if prior else None})
                    current[(tid, start)] = (now, total)
                except READ_ERRORS as error:
                    details = error_details(error, "read_thread_stat")
                    threads.append({"tid": tid, "status": "read_error", "error": details})
                    process["errors"].append(details)
        changed = self.identity._identity(process)
        if changed:
            self.previous.pop(key, None)
            return {"status": changed}
        self.previous[key] = current
        return {"status": "ok", "threads": threads, "truncated": truncated}

    def update(self, row, now, active):
        count = 0
        for process in row["processes"]:
            key = (process["pid"], process.get("start_ticks"))
            if key not in active or process.get("is_copilot") is not True:
                continue
            if process.get("status") != "ok":
                continue
            if count >= self.MAX_PROCESSES:
                process["thread_detail"] = {"status": "process_limit"}
                continue
            count += 1
            if key in self.last_read and now - self.last_read[key] < 1:
                process["thread_detail"] = {"status": "not_due"}
                continue
            self.last_read[key] = now
            started = time.perf_counter()
            try:
                detail = self._read(process, now)
            except READ_ERRORS as error:
                self.previous.pop(key, None)
                details = error_details(error, "read_thread_details")
                process["errors"].append(details)
                detail = {"status": "read_error", "error": details}
            detail.update(sampled_at=row["time"],
                          read_duration_ms=round((time.perf_counter() - started) * 1000, 3))
            process["thread_detail"] = detail
        self.previous = {key: value for key, value in self.previous.items() if key in active}
        self.last_read = {key: value for key, value in self.last_read.items() if key in active}
