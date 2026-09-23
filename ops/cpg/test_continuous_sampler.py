import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import memory_sampler as sampler
import memory_sampler_service as service
from memory_sampler_incident import IncidentCapture


def sample(index, kills=8, boot="boot-one"):
    return {"type": "sample", "time": str(index), "boot_id": boot,
            "group": {"oom_kills": kills}, "processes": [], "events": [], "alerts": []}


class ContinuousTests(unittest.TestCase):
    def test_oom_evidence_survives_normal_rotation_and_restart(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "logs"
            with sampler.Log(output, max_bytes=16384, backups=3) as log:
                incident = IncidentCapture(log, "boot-one")
                for index in range(8):
                    row = sample(index)
                    incident.observe(row, index)
                    log.write(row)
                row = sample(8, kills=9)
                incident.observe(row, 8)
                log.write(row)
                self.assertEqual(row["incident"]["previous_oom_kills"], 8)
                for index in range(9, 600):
                    row = sample(index, kills=9)
                    incident.observe(row, index)
                    log.write(row)
            before = (output / "oom-before.jsonl").read_bytes()
            after = (output / "oom-after.jsonl").read_bytes()
            self.assertIn(b'"incident"', before)
            self.assertIn(b'"time":"68"', after)
            self.assertNotIn(b'"time":"69"', after)
            with sampler.Log(output, max_bytes=16384, backups=3) as log:
                incident = IncidentCapture(log, "boot-one")
                row = sample(600, kills=9)
                incident.observe(row, 600)
                log.write(row)
                self.assertNotIn("incident", row)
            self.assertEqual((output / "oom-before.jsonl").read_bytes(), before)
            self.assertEqual((output / "oom-after.jsonl").read_bytes(), after)
            self.assertLessEqual(sum(p.stat().st_size for p in output.glob("*.jsonl*")), 6 * 16384)

    def test_restart_detects_counter_gap_but_reboot_and_decrease_do_not(self):
        with tempfile.TemporaryDirectory() as root:
            with sampler.Log(Path(root) / "logs") as log:
                log.write(sample(0))
                incident = IncidentCapture(log, "boot-one")
                row = sample(1, kills=9)
                incident.observe(row, 1)
                self.assertEqual(row["incident"]["since"], "0")
                log.write(row)
                rebooted = IncidentCapture(log, "boot-two")
                row = sample(2, kills=20, boot="boot-two")
                rebooted.observe(row, 2)
                self.assertNotIn("incident", row)
                row = sample(3, kills=0, boot="boot-two")
                rebooted.observe(row, 3)
                self.assertNotIn("incident", row)

    def test_latest_incident_replaces_previous_and_buffers_are_bounded(self):
        with tempfile.TemporaryDirectory() as root:
            with sampler.Log(Path(root) / "logs", max_bytes=1024) as log:
                incident = IncidentCapture(log, "boot-one")
                for index in range(400):
                    row = sample(index, kills=8 if index < 200 else 9)
                    incident.observe(row, index)
                    log.write(row)
                    self.assertLessEqual(incident.buffer_bytes, log.max_bytes)
                    self.assertLessEqual(len(incident.before), 300)
                row = sample(400, kills=10)
                incident.observe(row, 400)
                self.assertEqual(row["incident"]["previous_oom_kills"], 9)
            rows = [json.loads(line) for line in
                    (Path(root) / "logs" / "oom-before.jsonl").read_text().splitlines()]
            self.assertEqual(rows[-1]["time"], "400")
            after = (Path(root) / "logs" / "oom-after.jsonl").read_text().splitlines()
            self.assertEqual(len(after), 1)

    def test_incident_files_reject_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "logs"
            target = Path(root) / "target"
            target.write_text("keep")
            with sampler.Log(output) as log:
                incident = IncidentCapture(log, "boot-one")
                incident.observe(sample(0), 0)
                (output / "oom-before.jsonl").symlink_to(target)
                with self.assertRaisesRegex(RuntimeError, "symlink"):
                    incident.observe(sample(1, kills=9), 1)
            self.assertEqual(target.read_text(), "keep")

    def test_abrupt_writer_tail_is_repaired_explicitly(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "logs"
            with sampler.Log(output) as log:
                log.write(sample(0))
            with (output / "samples.jsonl").open("ab") as stream:
                stream.write(b'{"type":"sample","incomplete":')
            with patch("builtins.print") as report:
                with sampler.Log(output) as log:
                    self.assertEqual(list(log.records()), [sample(0)])
                    log.write(sample(1))
            self.assertIn("RECOVERED_INCOMPLETE_RECORD", str(report.call_args_list))
            self.assertEqual(len((output / "samples.jsonl").read_text().splitlines()), 2)

    def test_exact_default_storage_caps_under_repeated_rotation(self):
        mib = 1024 * 1024
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "logs"
            with sampler.Log(output) as log:
                self.assertEqual(log.max_bytes, 4 * mib)
                self.assertEqual(log.backups, 3)
                incident = IncidentCapture(log, "boot-one")
                for index in range(40):
                    row = sample(index, kills=8 if index < 8 else 9)
                    row["payload"] = "x" * (mib - 1024)
                    incident.observe(row, index)
                    log.write(row)
            regular = list(output.glob("samples.jsonl*"))
            evidence = list(output.glob("oom-*.jsonl"))
            self.assertEqual(len(regular), 4)
            self.assertEqual(len(evidence), 2)
            self.assertLessEqual(sum(p.stat().st_size for p in regular), 16 * mib)
            self.assertLessEqual(sum(p.stat().st_size for p in evidence), 8 * mib)
            self.assertTrue(all(p.stat().st_size <= 4 * mib for p in regular + evidence))
            for path in regular + evidence:
                for line in path.open():
                    json.loads(line)

    def test_continuous_main_has_no_sample_count_deadline(self):
        from test_memory_sampler import SamplerTests
        fixture = SamplerTests()
        fixture.setUp()
        try:
            output = fixture.root / "continuous"
            with patch.object(sampler, "SAMPLES", 1), \
                    patch.object(sampler, "boot_id", return_value="boot-one"), \
                    patch.object(sampler.time, "sleep", side_effect=[None, None, KeyboardInterrupt]), \
                    patch("builtins.print"):
                self.assertEqual(sampler.main(["--output", str(output), "--continuous"]), 0)
            rows = [json.loads(line) for line in (output / "samples.jsonl").read_text().splitlines()]
            self.assertEqual(sum(row["type"] == "sample" for row in rows), 3)
            self.assertEqual(rows[0]["interval_seconds"], 2)
            self.assertIsNone(rows[0]["duration_seconds"])
            self.assertEqual(rows[-1]["reason"], "interrupted")
        finally:
            fixture.doCleanups()

    def test_persistent_service_is_independent_boot_enabled_and_bounded(self):
        text = service.persistent_unit(1001, 1001)
        for setting in (
            "User=1001", "Group=1001", "Slice=system.slice", "RuntimeMaxSec=infinity",
            "Restart=on-failure", "RestartSec=30", "MemoryMax=33554432",
            "CPUQuota=5%", "LimitFSIZE=4194304", "StateDirectory=cli-memory-sampler-1001",
            "StateDirectoryMode=0700", "WantedBy=multi-user.target",
            "After=cpg-setup.service", "Wants=cpg-setup.service",
            "StandardOutput=journal", "LogRateLimitBurst=10", "--continuous",
        ):
            self.assertIn(setting, text)
        self.assertNotIn("/home/", text)
        self.assertNotIn("append:", text)
        with self.assertRaises(ValueError):
            service.persistent_unit(0, 0)


if __name__ == "__main__":
    unittest.main()
