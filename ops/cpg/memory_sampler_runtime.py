"""Bounded, same-UID Unix IPC; only the external sampler writes evidence."""
from collections import deque
import json
import math
import os
from pathlib import Path
import selectors
import socket
import stat
import struct
import time

import cpg_common as common
from memory_sampler_metrics import READ_ERRORS, process_stat

GREETING = b"CPG_MEMORY/1\n"
MAX_FRAME = 2048
MAX_CLIENTS = 16
MAX_PENDING = 64
FIELDS = frozenset((
    "schema", "sequence", "sampled_unix_ms", "uptime_ms",
    "heap_used_bytes", "heap_total_bytes", "heap_limit_bytes",
    "external_bytes", "array_buffers_bytes", "malloced_bytes",
    "peak_malloced_bytes", "native_contexts", "detached_contexts",
    "gc_count", "gc_major_count", "gc_duration_ms", "event_loop_delay_ms",
    "collection_duration_ms", "dropped_samples",
))


def validate(value):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError("Invalid runtime fields")
    for number in value.values():
        if (type(number) not in (int, float) or not 0 <= number <= 2**53 - 1
                or not math.isfinite(number)):
            raise ValueError("Invalid runtime number")
    if value["schema"] != 1:
        raise ValueError("Unsupported runtime schema")
    return value


class RuntimeCollector:
    def __init__(self, path=None, proc=Path("/proc")):
        self.path = path
        self.proc = proc
        self.selector = None
        self.listener = None
        self.clients = {}
        self.pending = deque()
        self.rejected = 0
        self.dropped = 0
        self.bound = False

    def __enter__(self):
        if self.path is None:
            return self
        if not self.path.is_absolute() or self.path.parent.resolve() != self.path.parent:
            raise RuntimeError("Runtime socket requires a non-symlink absolute parent")
        parent = self.path.parent.stat()
        if parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
            raise RuntimeError("Runtime socket directory must be private and owned")
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            info = None
        if info is not None:
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise RuntimeError("Refusing non-owned/non-socket IPC target")
            with socket.socket(socket.AF_UNIX) as probe:
                probe.settimeout(0.2)
                try:
                    probe.connect(str(self.path))
                except ConnectionRefusedError:
                    self.path.unlink()
                else:
                    raise RuntimeError("Runtime socket is already active")
        try:
            self.selector = selectors.DefaultSelector()
            self.listener = socket.socket(socket.AF_UNIX)
            self.listener.bind(str(self.path))
            self.bound = True
            self.path.chmod(0o600)
            self.listener.listen(MAX_CLIENTS)
            self.listener.setblocking(False)
            self.selector.register(self.listener, selectors.EVENT_READ)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def _close(self, client):
        self.selector.unregister(client)
        self.clients.pop(client, None)
        client.close()

    def _identity(self, credentials):
        pid, uid, _ = credentials
        if uid != os.getuid():
            raise PermissionError("Wrong UID")
        process = self.proc / str(pid)
        first = process_stat(self.proc, pid)["start_ticks"]
        group = common.memory_membership((process / "cgroup").read_text())
        if group != "/cpg.slice" and not group.startswith("/cpg.slice/"):
            raise PermissionError("Unprotected process")
        if Path(os.readlink(str(process / "exe"))).name not in ("copilot", "copilot (deleted)"):
            raise PermissionError("Not Copilot")
        if process_stat(self.proc, pid)["start_ticks"] != first:
            raise PermissionError("Process identity changed")
        return pid, first

    def _accept(self):
        client, _ = self.listener.accept()
        try:
            if len(self.clients) >= MAX_CLIENTS:
                self.rejected += 1
                client.close()
                return
            credentials = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if credentials[1] != os.getuid():
                raise PermissionError("Wrong UID")
            client.setblocking(False)
            if client.send(GREETING) != len(GREETING):
                raise RuntimeError("Incomplete IPC greeting")
            self.clients[client] = {"credentials": credentials, "identity": None,
                                    "buffer": b"", "last": None, "seen": time.monotonic()}
            self.selector.register(client, selectors.EVENT_READ)
        except READ_ERRORS:
            self.rejected += 1
            self.clients.pop(client, None)
            client.close()

    def _read(self, client):
        state = self.clients[client]
        try:
            data = client.recv(MAX_FRAME + 1)
            if not data:
                if state["buffer"]:
                    self.rejected += 1
                self._close(client)
                return
            state["buffer"] += data
            state["seen"] = time.monotonic()
            while b"\n" in state["buffer"]:
                frame, state["buffer"] = state["buffer"].split(b"\n", 1)
                if len(frame) > MAX_FRAME:
                    raise ValueError("Oversized runtime record")
                metrics = validate(json.loads(frame))
                if state["identity"] is None:
                    state["identity"] = self._identity(state["credentials"])
                now = time.monotonic()
                if state["last"] is not None and now - state["last"] < 0.25:
                    self.dropped += 1
                    continue
                state["last"] = now
                if len(self.pending) >= MAX_PENDING:
                    self.pending.popleft()
                    self.dropped += 1
                pid, ticks = state["identity"]
                self.pending.append({"pid": pid, "start_ticks": ticks,
                                     "received_monotonic_seconds": now, "metrics": metrics})
            if len(state["buffer"]) > MAX_FRAME:
                raise ValueError("Oversized runtime buffer")
        except (UnicodeError, RecursionError, *READ_ERRORS):
            self.rejected += 1
            self._close(client)

    def wait(self, seconds):
        if self.selector is None:
            time.sleep(seconds)
            return
        deadline = time.monotonic() + seconds
        operations = 0
        while time.monotonic() < deadline:
            for client, state in list(self.clients.items()):
                if time.monotonic() - state["seen"] > 15:
                    self.rejected += 1
                    self._close(client)
            events = self.selector.select(max(0, deadline - time.monotonic()))
            for key, _ in events:
                if key.fileobj is self.listener:
                    self._accept()
                else:
                    self._read(key.fileobj)
                operations += 1
            if operations >= 64:
                self.dropped += 1
                time.sleep(max(0, deadline - time.monotonic()))
                break

    def take(self):
        result = {"status": "listening" if self.listener else "disabled",
                  "samples": list(self.pending), "rejected": self.rejected,
                  "dropped": self.dropped, "connections": len(self.clients)}
        self.pending.clear()
        self.rejected = self.dropped = 0
        return result

    def __exit__(self, *args):
        for client in list(self.clients):
            self._close(client)
        if self.listener is not None:
            self.listener.close()
        if self.selector is not None:
            self.selector.close()
        if self.bound:
            self.path.unlink()
            self.bound = False
