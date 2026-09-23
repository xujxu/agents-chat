import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import memory_sampler as sampler
import memory_sampler_runtime as runtime
from memory_sampler_incident import IncidentCapture
from memory_sampler_anomalies import AllocationWatch, ThreadDetails
from test_memory_sampler import SamplerTests
from test_memory_sampler_runtime import metrics

MIB = 1024 * 1024


def row(index, malloc=1, kills=0, sequence=None):
    return {
        "type": "sample", "time": str(index), "boot_id": "boot",
        "group": {"oom_kills": kills, "usage": 600 * MIB},
        "processes": [{"pid": 42, "start_ticks": 120, "status": "ok",
                       "is_copilot": True, "errors": []}],
        "events": [], "alerts": [],
        "runtime": {"samples": [{"pid": 42, "start_ticks": 120,
                                "metrics": dict(metrics(), malloced_bytes=malloc * MIB,
                                                sequence=index if sequence is None else sequence)}]},
    }


class AnomalyTests(unittest.TestCase):
    def test_threshold_delta_hysteresis_identity_and_missing_samples(self):
        watch = AllocationWatch()
        for index, value, expected in ((0, 1, False), (1, 33, True), (2, 80, False),
                                       (3, 31, False), (4, 64, True)):
            sample = row(index, value)
            watch.update(sample, index)
            self.assertEqual(bool(sample["allocation_anomalies"]), expected)
        sample = row(5, 64)
        sample["runtime"]["samples"] = []
        watch.update(sample, 5)
        self.assertEqual(sample["allocation_anomalies"], [])
        self.assertIn((42, 120), watch.active(5))
        self.assertEqual(watch.active(35), set())
        sample = row(6, 64)
        sample["runtime"]["samples"][0]["start_ticks"] = 121
        watch.update(sample, 36)
        self.assertEqual(sample["allocation_anomalies"][0]["start_ticks"], 121)

    def test_replay_is_ignored_and_departed_state_is_removed(self):
        watch = AllocationWatch()
        watch.update(row(0), 0)
        sample = row(1, 80, sequence=0)
        watch.update(sample, 1)
        self.assertFalse(sample["allocation_anomalies"])
        sample = row(2)
        sample["runtime"]["samples"] = []
        sample["processes"] = []
        watch.update(sample, 2)
        self.assertEqual(watch.previous, {})
        self.assertEqual(watch.active(2), set())

    def test_anomaly_accelerates_external_sampling(self):
        watch, pace = AllocationWatch(), sampler.SamplingPace()
        sample = row(0, 80)
        watch.update(sample, 0)
        self.assertEqual(pace.update(sample, 0), 0.5)
        sample["allocation_anomalies"] = []
        self.assertEqual(pace.update(sample, 29), 0.5)
        self.assertEqual(pace.update(sample, 30), 2)

    def test_three_anomaly_pairs_survive_rotation_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "logs"
            with sampler.Log(output, max_bytes=2048) as log:
                capture = IncidentCapture(log, "boot")
                watch = AllocationWatch()
                for index in range(400):
                    sample = row(index, 80 if index in (1, 100, 200, 300) else 1)
                    watch.update(sample, index)
                    capture.observe(sample, index)
                    log.write(sample)
            pairs = sorted(output.glob("allocation-*.jsonl*"))
            self.assertEqual(len(pairs), 6)
            self.assertTrue(all(p.stat().st_size <= 2048 for p in pairs))
            before = {p.name: p.read_bytes() for p in pairs}
            with sampler.Log(output, max_bytes=2048) as log:
                capture = IncidentCapture(log, "boot")
                sample = row(401)
                capture.observe(sample, 401)
                log.write(sample)
            self.assertEqual(before, {p.name: p.read_bytes() for p in pairs})
            self.assertFalse((output / "oom-before.jsonl").exists())
            self.assertIn(b'"detected_at":"300"', before["allocation-before.jsonl"])
            self.assertIn(b'"detected_at":"200"', before["allocation-before.jsonl.1"])
            self.assertIn(b'"detected_at":"100"', before["allocation-before.jsonl.2"])

    def test_oom_and_allocation_capture_are_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            with sampler.Log(Path(directory) / "logs") as log:
                capture, watch = IncidentCapture(log, "boot"), AllocationWatch()
                for index, malloc, kills in ((0, 1, 0), (1, 80, 0), (2, 80, 1)):
                    sample = row(index, malloc, kills)
                    watch.update(sample, index)
                    capture.observe(sample, index)
                    log.write(sample)
            output = Path(directory) / "logs"
            self.assertIn(b'"allocation_incident"', (output / "allocation-before.jsonl").read_bytes())
            self.assertIn(b'"incident"', (output / "oom-before.jsonl").read_bytes())

    def test_anomaly_rotation_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "logs"
            with sampler.Log(output) as log:
                (output / "allocation-before.jsonl.2").symlink_to(output / "samples.jsonl")
                capture, watch = IncidentCapture(log, "boot"), AllocationWatch()
                sample = row(1, 80)
                watch.update(sample, 1)
                with self.assertRaisesRegex(RuntimeError, "symlink"):
                    capture.observe(sample, 1)

    def test_default_allocation_files_have_one_mib_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            with sampler.Log(Path(directory) / "logs") as log:
                self.assertTrue(log.evidence("allocation-before.jsonl", b"x" * MIB))
                self.assertFalse(log.evidence("allocation-before.jsonl", b"x"))
                self.assertEqual(log.evidence_limit("oom-before.jsonl", log.max_bytes), 4 * MIB)
                with self.assertRaises(ValueError):
                    log.evidence("allocation-before.jsonl.3", b"")

    def test_runtime_schema_two_is_strict_and_schema_one_still_works(self):
        self.assertEqual(runtime.validate(metrics()), metrics())
        modern = dict(metrics(), schema=2, **{key: 1 for key in runtime.EXTRA_FIELDS})
        modern["versions"] = {"node": "24.13.0", "v8": "13.6.233.17-node.37",
                              "sampler": "2", "cli": "1.0.88"}
        self.assertEqual(runtime.validate(modern), modern)
        for value in ("secret\nprompt", "x" * 65, 12):
            bad = dict(modern, versions=dict(modern["versions"], cli=value))
            with self.assertRaises(ValueError):
                runtime.validate(bad)


class ThreadTests(unittest.TestCase):
    def setUp(self):
        self.fixture = SamplerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.proc = self.fixture.proc
        self.details = ThreadDetails(self.proc)
        self.task = self.proc / "42/task/43"
        self.task.mkdir(parents=True)
        self.write_stat(100, 20)

    def write_stat(self, start, cpu):
        fields = ["S", "1"] + ["0"] * 17 + [str(start)]
        fields[11] = str(cpu)
        (self.task / "stat").write_text("43 (V8 Worker) " + " ".join(fields))

    def test_thread_identity_deltas_interval_and_expiry(self):
        sample = row(0)
        self.details.update(sample, 0, {(42, 120)})
        entry = sample["processes"][0]["thread_detail"]["threads"][0]
        self.assertEqual(entry["name"], "V8 Worker")
        self.assertIsNone(entry["cpu_delta_ticks"])
        self.write_stat(100, 30)
        sample = row(1)
        self.details.update(sample, 0.5, {(42, 120)})
        self.assertEqual(sample["processes"][0]["thread_detail"]["status"], "not_due")
        self.details.update(sample, 1, {(42, 120)})
        entry = sample["processes"][0]["thread_detail"]["threads"][0]
        self.assertEqual(entry["cpu_delta_ticks"], 10)
        self.assertEqual(entry["elapsed_seconds"], 1)
        self.write_stat(101, 40)
        self.details.update(sample, 2, {(42, 120)})
        self.assertIsNone(sample["processes"][0]["thread_detail"]["threads"][0]["cpu_delta_ticks"])
        self.details.update(sample, 33, set())
        self.assertEqual(self.details.previous, {})

    def test_limits_permission_and_process_identity_are_explicit(self):
        sample = row(0)
        with patch.object(ThreadDetails, "MAX_THREADS", 0):
            self.details.update(sample, 0, {(42, 120)})
        self.assertTrue(sample["processes"][0]["thread_detail"]["truncated"])
        with patch.object(Path, "open", side_effect=PermissionError("PRIVATE")):
            self.details.update(sample, 1, {(42, 120)})
        self.assertEqual(sample["processes"][0]["thread_detail"]["status"], "read_error")
        self.assertNotIn("PRIVATE", json.dumps(sample))
        (self.proc / "42/cgroup").write_text("2:memory:/outside\n")
        self.details.update(sample, 2, {(42, 120)})
        self.assertEqual(sample["processes"][0]["thread_detail"]["status"], "left_group")

    def test_process_limit_and_reuse_discard_state(self):
        sample = row(0)
        with patch.object(ThreadDetails, "MAX_PROCESSES", 0):
            self.details.update(sample, 0, {(42, 120)})
        self.assertEqual(sample["processes"][0]["thread_detail"]["status"], "process_limit")
        with patch.object(self.details.identity, "_identity", side_effect=[None, "pid_reused"]):
            self.details.update(sample, 1, {(42, 120)})
        self.assertEqual(sample["processes"][0]["thread_detail"]["status"], "pid_reused")
        self.assertEqual(self.details.previous, {})


if __name__ == "__main__":
    unittest.main()
