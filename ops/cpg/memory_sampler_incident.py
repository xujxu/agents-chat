"""Keep the latest observed OOM separate from the rolling sample log."""
from collections import deque


class IncidentCapture:
    def __init__(self, log, boot):
        self.log = log
        self.boot = boot
        self.before = deque()
        self.buffer_bytes = 0
        self.previous_kills = None
        self.previous_time = None
        self.after_until = None
        self.allocation_after_until = None
        for row in log.records():
            if row.get("type") == "sample" and row.get("boot_id") == boot:
                self._remember(log.encode(row))
                self.previous_kills = row["group"]["oom_kills"]
                self.previous_time = row["time"]

    def _remember(self, data):
        if len(data) > self.log.max_bytes:
            raise ValueError("Single incident record exceeds log size bound")
        self.before.append(data)
        self.buffer_bytes += len(data)
        while self.buffer_bytes > self.log.max_bytes or len(self.before) > 300:
            self.buffer_bytes -= len(self.before.popleft())

    def observe(self, row, now):
        kills = row["group"]["oom_kills"]
        increased = self.previous_kills is not None and kills > self.previous_kills
        if increased:
            row["incident"] = {
                "previous_oom_kills": self.previous_kills, "oom_kills": kills,
                "since": self.previous_time, "detected_at": row["time"],
                "victim_identity": "not_proven_by_sampling",
            }
        allocation = bool(row.get("allocation_anomalies"))
        # Merge nearby process anomalies into the current post window.
        new_allocation = allocation and (
            self.allocation_after_until is None or now > self.allocation_after_until)
        if new_allocation:
            row["allocation_incident"] = {"detected_at": row["time"],
                                          "post_seconds": 60}
        data = self.log.encode(row)
        self._remember(data)
        if increased:
            # Replace only on a new OOM; ordinary rotation never touches this evidence.
            self.log.evidence("oom-before.jsonl", b"".join(self.before), replace=True)
            self.log.evidence("oom-after.jsonl", b"", replace=True)
            self.after_until = now + 60
        if new_allocation:
            self.log.rotate_allocations()
            limit = self.log.evidence_limit("allocation-before.jsonl", self.log.max_bytes)
            selected, size = deque(), 0
            for record in reversed(self.before):
                if size + len(record) > limit:
                    break
                selected.appendleft(record)
                size += len(record)
            if not selected:
                # Preserve the trigger even when an unusually large ordinary row cannot fit.
                selected.append(self.log.encode({
                    "type": "allocation_incident", "time": row["time"],
                    "boot_id": self.boot, "allocation_anomalies": row["allocation_anomalies"],
                    "alerts": ["ALLOCATION_PRE_RECORD_TOO_LARGE"],
                }))
                row["alerts"].append("ALLOCATION_PRE_RECORD_TOO_LARGE")
            self.log.evidence("allocation-before.jsonl", b"".join(selected), replace=True)
            self.log.evidence("allocation-after.jsonl", b"", replace=True)
            self.allocation_after_until = now + 60
        if self.allocation_after_until is not None:
            if now > self.allocation_after_until:
                self.allocation_after_until = None
            elif not self.log.evidence("allocation-after.jsonl", data):
                row["alerts"].append("ALLOCATION_POST_CAPTURE_FULL: stopped at per-file size bound")
                self.allocation_after_until = None
        if self.after_until is not None:
            if now > self.after_until:
                self.after_until = None
            elif not self.log.evidence("oom-after.jsonl", data):
                row["alerts"].append("OOM_POST_CAPTURE_FULL: stopped at per-file size bound")
                self.after_until = None
        self.previous_kills = kills
        self.previous_time = row["time"]
