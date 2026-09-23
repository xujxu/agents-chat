import json
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import memory_sampler as sampler
import memory_sampler_launch as launch
import memory_sampler_runtime as runtime
from memory_sampler_incident import IncidentCapture


def metrics():
    return {key: 1 for key in runtime.FIELDS}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.collector = runtime.RuntimeCollector(self.root / "runtime.sock")
        self.collector.__enter__()
        self.addCleanup(self.collector.__exit__, None, None, None)
        identity = patch.object(self.collector, "_identity", return_value=(42, 123))
        identity.start()
        self.addCleanup(identity.stop)

    def connect(self):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(self.collector.path))
        self.collector.wait(0.01)
        self.assertEqual(client.recv(128), runtime.GREETING)
        self.addCleanup(client.close)
        return client

    def test_internal_sample_survives_disconnect_and_is_preserved_in_oom_evidence(self):
        client = self.connect()
        client.sendall((json.dumps(metrics()) + "\n").encode())
        client.close()
        self.collector.wait(0.02)
        data = self.collector.take()
        self.assertEqual(data["samples"][0]["pid"], 42)
        self.assertEqual(data["samples"][0]["start_ticks"], 123)
        self.assertEqual(data["samples"][0]["metrics"], metrics())
        with sampler.Log(self.root / "logs") as log:
            capture = IncidentCapture(log, "boot")
            first = {"type": "sample", "time": "1", "boot_id": "boot",
                     "group": {"oom_kills": 0}, "alerts": [], "runtime": data}
            capture.observe(first, 1)
            log.write(first)
            second = dict(first, time="2", group={"oom_kills": 1},
                          runtime=self.collector.take())
            capture.observe(second, 2)
            log.write(second)
        evidence = (self.root / "logs/oom-before.jsonl").read_text()
        self.assertIn('"heap_used_bytes":1', evidence)
        self.assertEqual(self.collector.take()["samples"], [])

    def test_partial_and_multiple_frames_are_reassembled(self):
        client = self.connect()
        payload = (json.dumps(metrics()) + "\n").encode()
        client.sendall(payload[:10])
        self.collector.wait(0.01)
        self.assertEqual(self.collector.take()["samples"], [])
        client.sendall(payload[10:])
        self.collector.wait(0.01)
        self.assertEqual(len(self.collector.take()["samples"]), 1)

    def test_non_numeric_unknown_and_nonfinite_data_are_not_logged(self):
        for change in ({"secret": "PRIVATE"}, {"heap_used_bytes": True},
                       {"heap_used_bytes": float("nan")}, {"heap_used_bytes": -1}):
            client = self.connect()
            client.sendall((json.dumps(dict(metrics(), **change)) + "\n").encode())
            self.collector.wait(0.01)
            data = self.collector.take()
            self.assertEqual(data["samples"], [])
            self.assertGreater(data["rejected"], 0)
            self.assertNotIn("PRIVATE", json.dumps(data))
            client.close()

    def test_oversize_partial_record_is_rejected_and_memory_is_bounded(self):
        client = self.connect()
        client.sendall(b"x" * (runtime.MAX_FRAME + 1))
        self.collector.wait(0.01)
        self.assertGreater(self.collector.take()["rejected"], 0)
        self.assertEqual(len(self.collector.clients), 0)

    def test_pending_ring_has_exact_bound_and_explicit_drop_count(self):
        client = self.connect()
        server = next(iter(self.collector.clients))
        payload = (json.dumps(metrics()) + "\n").encode()
        for index in range(runtime.MAX_PENDING + 10):
            client.sendall(payload)
            with patch.object(runtime.time, "monotonic", return_value=index + 1):
                self.collector._read(server)
            self.assertLessEqual(len(self.collector.pending), runtime.MAX_PENDING)
        data = self.collector.take()
        self.assertEqual(len(data["samples"]), runtime.MAX_PENDING)
        self.assertEqual(data["dropped"], 10)
        self.assertEqual(self.collector.take()["dropped"], 0)

    def test_reject_unprotected_peer_and_do_not_keep_payload(self):
        client = self.connect()
        with patch.object(self.collector, "_identity", side_effect=PermissionError()):
            client.sendall((json.dumps(metrics()) + "\n").encode())
            self.collector.wait(0.01)
        data = self.collector.take()
        self.assertEqual(data["samples"], [])
        self.assertEqual(data["rejected"], 1)

    def test_socket_does_not_replace_regular_file_or_active_listener(self):
        with self.assertRaises(RuntimeError):
            with runtime.RuntimeCollector(self.collector.path):
                pass
        path = self.root / "keep"
        path.write_text("keep")
        with self.assertRaises(RuntimeError):
            with runtime.RuntimeCollector(path):
                pass
        self.assertEqual(path.read_text(), "keep")
        self.assertEqual(self.collector.path.stat().st_mode & 0o777, 0o600)

    def test_pid_identity_comes_from_peer_not_payload(self):
        payload = dict(metrics(), pid=999)
        with self.assertRaises(ValueError):
            runtime.validate(payload)

    def test_opt_in_environment_is_pid_scoped_and_preserves_original_options(self):
        module = self.root / "memory_sampler_preload.cjs"
        module.write_text("")
        with patch.object(launch, "PRELOAD", module), \
                patch.object(launch, "socket_path", return_value=self.collector.path), \
                patch.object(launch, "check_collector"), \
                patch.object(launch, "check_preload"):
            env = launch.environment(1001, 123, {"NODE_OPTIONS": "--trace-warnings", "KEEP": "yes"})
        self.assertEqual(env["KEEP"], "yes")
        self.assertEqual(env["NODE_OPTIONS"], "--trace-warnings")
        self.assertEqual(env["CPG_MEMORY_PID"], "123")
        self.assertEqual(env["CPG_MEMORY_SOCKET"], str(self.collector.path))

    def test_burst_sampling_is_bounded_and_recovers(self):
        pace = sampler.SamplingPace()
        row = {"group": {"usage": 400 * 1048576}}
        self.assertEqual(pace.update(row, 0), 2)
        row["group"]["usage"] += 128 * 1048576
        self.assertEqual(pace.update(row, 2), 0.5)
        self.assertEqual(pace.update(row, 61), 0.5)
        self.assertEqual(pace.update(row, 62), 2)
        row["group"]["usage"] = sampler.WARN_BYTES
        self.assertEqual(pace.update(row, 63), 0.5)

    def test_cli_version_probe_has_timeout_and_rejects_unexpected_output(self):
        for output in ("GitHub Copilot CLI 1.0.88\n", "1.0.88\nCommit: abc\n"):
            with patch.object(launch.subprocess, "run",
                              return_value=subprocess.CompletedProcess([], 0, output)) as run:
                self.assertEqual(launch.cli_version("/original/copilot"), "1.0.88")
                self.assertEqual(run.call_args.kwargs["timeout"], 10)
        with patch.object(launch.subprocess, "run",
                          return_value=subprocess.CompletedProcess([], 0, "PRIVATE")):
            with self.assertRaisesRegex(RuntimeError, "Unrecognized"):
                launch.cli_version("/original/copilot")
        with patch.object(launch.subprocess, "run",
                          side_effect=subprocess.TimeoutExpired("PRIVATE", 10)):
            with self.assertRaisesRegex(RuntimeError, "TimeoutExpired"):
                launch.cli_version("/original/copilot")


if __name__ == "__main__":
    unittest.main()
