import json
from unittest import TestCase, main
from unittest.mock import patch

import memory_sampler as sampler
import memory_sampler_metrics as metrics
import test_memory_sampler as fixtures


class MetricsTests(TestCase):
    def setUp(self):
        self.fixture = fixtures.SamplerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.proc = self.fixture.proc
        self.details = metrics.MemoryDetails(self.proc, sampler.WARN_BYTES)
        self.rollup = self.proc / "42" / "smaps_rollup"
        self.rollup.write_text(
            "00400000-ffffffff ---p 00000000 00:00 0 PRIVATE-NOT-LOGGED\n"
            "Rss: 2000 kB\nPss: 1800 kB\nShared_Clean: 100 kB\n"
            "Shared_Dirty: 200 kB\nPrivate_Clean: 300 kB\nPrivate_Dirty: 1400 kB\n"
            "Anonymous: 1500 kB\nSwap: 0 kB\nAnonHugePages: 1024 kB\n")

    def row(self):
        return sampler.snapshot("metrics")

    def test_cpu_and_faults_use_correct_stat_fields_and_own_process_only(self):
        fields = ["S", "1"] + ["0"] * 17 + ["120"]
        fields[7:13] = ["1234", "8888", "7", "9999", "250", "75"]
        (self.proc / "42" / "stat").write_text("42 (name ) with spaces) " + " ".join(fields))
        result = sampler.process_sample(42)
        self.assertEqual(result["minor_faults"], 1234)
        self.assertEqual(result["major_faults"], 7)
        self.assertEqual(result["cpu_user_ticks"], 250)
        self.assertEqual(result["cpu_system_ticks"], 75)
        self.assertEqual(result["start_ticks"], 120)
        row = self.row()
        self.assertGreater(row["clock_ticks_per_second"], 0)
        self.assertEqual(row["schema"], 2)
        self.assertEqual(row["group"]["total_pgfault"], 55)
        self.assertEqual(row["group"]["total_pgmajfault"], 3)

    def test_virtual_and_shared_memory_fields_are_bytes(self):
        process = sampler.process_sample(42)
        for field, kib in (
            ("virtual_bytes", 9000), ("data_virtual_bytes", 6000),
            ("stack_virtual_bytes", 132), ("page_table_bytes", 64),
            ("shared_memory_bytes", 0),
        ):
            self.assertEqual(process[field], kib * 1024)

    def test_rollup_baseline_and_exact_low_high_intervals(self):
        for now, high, expected in (
            (0, False, "ok"), (29, True, "not_due"), (30, True, "ok"),
            (59, True, "not_due"), (60, True, "ok"), (119, False, "not_due"),
            (120, False, "ok"),
        ):
            row = self.row()
            row["group"]["usage"] = sampler.WARN_BYTES if high else sampler.WARN_BYTES - 1
            self.details.update(row, now)
            result = row["processes"][0]["memory_detail"]
            self.assertEqual(result["status"], expected, now)
            if expected == "ok":
                self.assertEqual(result["anonymous_bytes"], 1500 * 1024)
                self.assertEqual(result["private_dirty_bytes"], 1400 * 1024)
                self.assertEqual(result["sampled_at"], row["time"])
                self.assertGreaterEqual(result["read_duration_ms"], 0)
                self.assertIsNone(result["pss_anon_bytes"])
                self.assertIn("pss_anon_bytes", result["unavailable_fields"])
            self.assertNotIn("PRIVATE", json.dumps(row))

    def test_skipped_interval_does_not_read_rollup(self):
        self.details.update(self.row(), 0)
        self.rollup.unlink()
        row = self.row()
        self.details.update(row, 2)
        self.assertEqual(row["processes"][0]["memory_detail"]["status"], "not_due")
        self.assertEqual(row["processes"][0]["errors"], [])

    def test_unavailable_detail_is_explicit_and_does_not_discard_basic_sample(self):
        self.rollup.unlink()
        row = self.row()
        self.details.update(row, 0)
        process = row["processes"][0]
        self.assertEqual(process["status"], "ok")
        self.assertEqual(process["rss_bytes"], 2000 * 1024)
        self.assertEqual(process["memory_detail"]["status"], "read_error")
        self.assertEqual(process["errors"][-1]["operation"], "read_smaps_rollup")
        self.assertEqual(process["errors"][-1]["errno"], 2)
        row = self.row()
        self.details.update(row, 2)
        self.assertEqual(row["processes"][0]["memory_detail"]["status"], "not_due")

    def test_permission_failure_never_logs_private_exception_text(self):
        row = self.row()
        with patch.object(metrics, "read_rollup", side_effect=PermissionError("SECRET")):
            self.details.update(row, 0)
        self.assertEqual(row["processes"][0]["memory_detail"]["status"], "read_error")
        self.assertNotIn("SECRET", json.dumps(row))

    def test_malformed_or_incomplete_rollup_is_not_fake_zero(self):
        for content in ("Rss: INVALID kB\n", "Rss: 1024 kB\n"):
            self.rollup.write_text(content)
            with self.assertRaises((ValueError, KeyError)):
                metrics.read_rollup(self.rollup)

    def test_pid_reuse_and_group_departure_discard_detail(self):
        for reuse in (True, False):
            row = self.row()
            details = metrics.MemoryDetails(self.proc, sampler.WARN_BYTES)
            original = metrics.read_rollup

            def changed(path):
                result = original(path)
                if reuse:
                    (self.proc / "42" / "stat").write_text("42 (reused) S 1 " + "0 " * 17 + "121")
                else:
                    (self.proc / "42" / "cgroup").write_text("2:memory:/outside\n")
                return result

            with patch.object(metrics, "read_rollup", side_effect=changed):
                details.update(row, 0)
            detail = row["processes"][0]["memory_detail"]
            self.assertEqual(detail["status"], "pid_reused" if reuse else "left_group")
            self.assertNotIn("anonymous_bytes", detail)
            (self.proc / "42" / "stat").write_text("42 (original) S 1 " + "0 " * 17 + "120")

    def test_non_copilot_and_departed_processes_do_not_accumulate_state(self):
        row = self.row()
        self.details.update(row, 0)
        self.assertEqual(len(self.details.last_read), 1)
        row = self.row()
        row["processes"][0]["is_copilot"] = False
        self.details.update(row, 2)
        self.assertEqual(row["processes"][0]["memory_detail"]["status"], "not_copilot")
        self.assertEqual(self.details.last_read, {})

    def test_main_wires_details_and_keeps_read_errors_nonfatal(self):
        output = self.fixture.root / "metrics-output"
        self.rollup.unlink()
        with patch.object(sampler, "SAMPLES", 2), \
                patch.object(sampler.time, "sleep"), patch("builtins.print") as report:
            self.assertEqual(sampler.main(["--output", str(output)]), 0)
        rows = [json.loads(line) for line in (output / "samples.jsonl").read_text().splitlines()]
        samples = [row for row in rows if row["type"] == "sample"]
        self.assertEqual(len(samples), 2)
        self.assertEqual(samples[0]["processes"][0]["memory_detail"]["status"], "read_error")
        self.assertIn("READ_ERROR", str(report.call_args_list))
        self.assertEqual(rows[-1]["reason"], "duration_complete")


if __name__ == "__main__":
    main()
