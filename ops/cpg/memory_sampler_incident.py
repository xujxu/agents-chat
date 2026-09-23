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
        data = self.log.encode(row)
        self._remember(data)
        if increased:
            # Replace only on a new OOM; ordinary rotation never touches this evidence.
            self.log.evidence("oom-before.jsonl", b"".join(self.before), replace=True)
            self.log.evidence("oom-after.jsonl", b"", replace=True)
            self.after_until = now + 60
        if self.after_until is not None:
            if now > self.after_until:
                self.after_until = None
            elif not self.log.evidence("oom-after.jsonl", data):
                row["alerts"].append("OOM_POST_CAPTURE_FULL: stopped at per-file size bound")
                self.after_until = None
        self.previous_kills = kills
        self.previous_time = row["time"]
