import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cpg_common as common
import memory_sampler as sampler


class SamplerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.group = self.root / "cpg.slice"
        self.group.mkdir()
        (self.group / common.WORKLOAD).mkdir()
        for name, value in (
            ("memory.limit_in_bytes", common.LIMIT),
            ("memory.usage_in_bytes", 600 * common.MIB),
            ("memory.failcnt", 2), ("memory.use_hierarchy", 1),
            ("memory.oom_control", "oom_kill_disable 0\noom_kill 0\n"),
            ("memory.stat", "total_inactive_file 1024\ntotal_cache 2048\ntotal_rss 4096\n"),
            ("cgroup.procs", ""),
        ):
            (self.group / name).write_text(str(value))
        child = self.group / common.WORKLOAD
        (child / "memory.oom_control").write_text("oom_kill_disable 0\noom_kill 7\n")
        (child / "cgroup.procs").write_text("42\n")
        (self.proc / "self").mkdir()
        (self.proc / "self" / "cgroup").write_text("2:memory:/user.slice/session-1.scope\n")
        (self.proc / "meminfo").write_text("MemTotal: 4000000 kB\nMemAvailable: 2000000 kB\n")
        self.process(42, 120)
        for obj, field, value in (
            (sampler, "PROC", self.proc), (common, "GROUP", self.group),
        ):
            change = patch.object(obj, field, value)
            change.start()
            self.addCleanup(change.stop)

    def process(self, pid, start):
        directory = self.proc / str(pid)
        directory.mkdir(exist_ok=True)
        fields = ["S", "1"] + ["0"] * 17 + [str(start)]
        (directory / "stat").write_text(f"{pid} (name with ) spaces) " + " ".join(fields))
        (directory / "status").write_text(
            "Name:\tPRIVATE-NOT-LOGGED\nPPid:\t1\nVmRSS:\t2000 kB\nVmHWM:\t2500 kB\n"
            "RssAnon:\t1500 kB\nRssFile:\t500 kB\nVmSwap:\t0 kB\nThreads:\t12\n")
        (directory / "exe").symlink_to("/private/copilot")
        (directory / "cgroup").write_text("2:memory:/cpg.slice/cpg-workload.service\n")
        (directory / "cmdline").write_text("SECRET-COMMAND")
        (directory / "environ").write_text("SECRET-ENV")

    def test_refuses_sampler_in_protected_group(self):
        for membership in ("/cpg.slice", "/cpg.slice/cpg-workload.service"):
            (self.proc / "self" / "cgroup").write_text("2:memory:" + membership + "\n")
            with self.assertRaisesRegex(RuntimeError, "outside"):
                sampler.ensure_outside()
        (self.proc / "self" / "cgroup").write_text("2:memory:/cpg.slice-other\n")
        sampler.ensure_outside()

    def test_refuses_v2_instead_of_reporting_wrong_counters(self):
        (self.proc / "self" / "cgroup").write_text("0::/user.slice\n")
        with self.assertRaisesRegex(RuntimeError, "v1"):
            sampler.ensure_outside()

    def test_numeric_process_identity_and_no_private_content(self):
        result = sampler.process_sample(42)
        self.assertEqual(result["start_ticks"], 120)
        self.assertEqual(result["rss_bytes"], 2000 * 1024)
        self.assertEqual(result["anonymous_bytes"], 1500 * 1024)
        self.assertEqual(result["threads"], 12)
        self.assertTrue(result["is_copilot"])
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("/private", json.dumps(result))

    def test_exited_process_is_explicit(self):
        result = sampler.process_sample(99999)
        self.assertEqual(result["status"], "exited_during_sample")

    def test_permission_error_is_not_silently_ignored(self):
        with patch.object(Path, "read_text", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                sampler.process_sample(42)

    def test_pid_reuse_is_not_misreported_as_continuous_process(self):
        with patch.object(sampler, "start_ticks", side_effect=[120, 121]):
            self.assertEqual(sampler.process_sample(42)["status"], "pid_reused_during_sample")

    def test_snapshot_counts_child_oom_and_keeps_charge_distinct_from_rss(self):
        result = sampler.snapshot("old-session")
        self.assertEqual(result["group"]["oom_kills"], 7)
        self.assertEqual(result["group"]["usage"], 600 * common.MIB)
        self.assertEqual(result["processes"][0]["rss_bytes"], 2000 * 1024)
        self.assertEqual(result["host_available_bytes"], 2000000 * 1024)
        self.assertEqual(result["group"]["total_cache"], 2048)

    def test_changed_guard_limit_is_explicit_error(self):
        (self.group / "memory.limit_in_bytes").write_text(str(common.LIMIT * 2))
        with self.assertRaisesRegex(RuntimeError, "boundary"):
            sampler.snapshot("old-session")

    def test_alarm_boundary_oom_and_recovery(self):
        alarms = sampler.Alerts()
        row = sampler.snapshot("old-session")
        self.assertEqual(alarms.update(row, 0), [])
        row["group"]["usage"] = sampler.WARN_BYTES
        self.assertIn("HIGH_MEMORY", " ".join(alarms.update(row, 1)))
        self.assertEqual(alarms.update(row, 2), [])
        self.assertIn("HIGH_MEMORY", " ".join(alarms.update(row, 62)))
        row["group"]["oom_kills"] += 1
        self.assertIn("OOM_COUNTER_INCREASE", " ".join(alarms.update(row, 63)))
        row["group"]["usage"] = 500 * common.MIB
        self.assertIn("RECOVERED", " ".join(alarms.update(row, 64)))

    def test_bounded_rotation_private_permissions_and_duplicate_lock(self):
        output = self.root / "logs"
        with sampler.Log(output, max_bytes=220, backups=2) as log:
            with self.assertRaises((BlockingIOError, RuntimeError)):
                with sampler.Log(output):
                    self.fail("second writer acquired lock")
            for index in range(30):
                log.write({"index": index, "payload": "x" * 90})
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        files = list(output.glob("samples.jsonl*"))
        self.assertEqual(len(files), 3)
        for path in files:
            self.assertLessEqual(path.stat().st_size, 220)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            for line in path.read_text().splitlines():
                json.loads(line)

    def test_oversize_record_and_symlink_are_rejected(self):
        output = self.root / "logs"
        with sampler.Log(output, max_bytes=100) as log:
            with self.assertRaisesRegex(ValueError, "record"):
                log.write({"large": "x" * 200})
        link = self.root / "link"
        link.symlink_to(output, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            with sampler.Log(link):
                self.fail("opened linked directory")

    def test_bounded_main_writes_samples_and_stop_marker(self):
        output = self.root / "run"
        with patch.object(sampler, "SAMPLES", 2), patch.object(sampler.time, "sleep"), \
                patch("builtins.print"):
            self.assertEqual(sampler.main(["--output", str(output), "--label", "new-session"]), 0)
        rows = [json.loads(line) for line in (output / "samples.jsonl").read_text().splitlines()]
        self.assertEqual(sum(row["type"] == "sample" for row in rows), 2)
        self.assertEqual(rows[-1]["reason"], "duration_complete")


if __name__ == "__main__":
    unittest.main()
