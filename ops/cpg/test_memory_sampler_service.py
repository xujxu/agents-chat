import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import memory_sampler_service as service


class ServiceTests(unittest.TestCase):
    def test_nonroot_service_is_bounded_and_outside_cpg(self):
        command = service.start_command(Path("/package"), Path("/tmp/logs"), 1001, 1001)
        self.assertEqual(command[0], "/usr/bin/systemd-run")
        properties = dict(argument[len("--property="):].split("=", 1)
                          for argument in command if argument.startswith("--property="))
        expected = {
            "Type": "exec", "User": "1001", "Group": "1001", "Slice": "system.slice",
            "RuntimeMaxSec": "7200", "TimeoutStopSec": "5", "Restart": "no",
            "KillSignal": "SIGINT", "MemoryMax": "33554432", "CPUQuota": "5%",
            "TasksMax": "8", "Nice": "19", "IOSchedulingClass": "idle",
            "LimitFSIZE": "4194304", "UMask": "0077", "NoNewPrivileges": "yes",
            "ProtectSystem": "strict", "ProtectHome": "read-only",
            "ProtectControlGroups": "yes", "ProtectKernelTunables": "yes",
            "StandardOutput": "append:/tmp/logs/console.log", "StandardError": "inherit",
            "ReadWritePaths": "/tmp/logs",
        }
        for key, value in expected.items():
            self.assertEqual(properties[key], value, key)
        self.assertNotIn("--user", command)
        self.assertNotIn("--scope", command)
        self.assertNotIn("--pty", command)
        self.assertEqual(command[-7:], [
            "/usr/bin/python3", "-B", "/package/memory_sampler.py",
            "--output", "/tmp/logs", "--label", "new-session",
        ])

    def test_fixed_output_and_unit_do_not_accumulate_per_run(self):
        self.assertEqual(service.output_directory(1001), Path("/tmp/cli-memory-sampler-1001"))
        self.assertEqual(service.unit_name(1001), "cli-memory-sampler-1001.service")

    def test_command_refuses_root_identity(self):
        with self.assertRaisesRegex(ValueError, "non-root"):
            service.start_command(Path("/package"), Path("/tmp/logs"), 0, 0)

    def test_prepare_output_private_console_and_single_writer(self):
        import memory_sampler as sampler
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "logs"
            service.prepare_output(output)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            console = output / "console.log"
            self.assertEqual(console.stat().st_mode & 0o777, 0o600)
            console.write_text("previous evidence\n")
            service.prepare_output(output)
            self.assertEqual(console.read_text(), "previous evidence\n")
            with sampler.Log(output):
                with self.assertRaises(BlockingIOError):
                    service.prepare_output(output)

    def test_console_symlink_and_oversize_refused(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "logs"
            service.prepare_output(output)
            console = output / "console.log"
            console.unlink()
            target = Path(root) / "target"
            target.write_text("keep")
            console.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                service.prepare_output(output)
            self.assertEqual(target.read_text(), "keep")
            console.unlink()
            with console.open("wb") as stream:
                stream.truncate(4 * 1024 * 1024 + 1)
            console.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, "bound"):
                service.prepare_output(output)

    def test_main_uses_noninteractive_sudo_only_for_transient_start(self):
        with patch.object(os, "getuid", return_value=1001), \
                patch.object(os, "getgid", return_value=1001), \
                patch.object(service, "prepare_output") as prepare, \
                patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                patch("builtins.print"):
            self.assertEqual(service.main([]), 0)
        prepare.assert_called_once_with(service.output_directory(1001))
        self.assertEqual(run.call_args.args[0][:3], ["sudo", "-n", "/usr/bin/systemd-run"])

    def test_no_silent_success_if_administrator_authorization_fails(self):
        with patch.object(os, "getuid", return_value=1001), \
                patch.object(os, "getgid", return_value=1001), \
                patch.object(service, "prepare_output"), \
                patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1)), \
                patch("builtins.print") as output:
            self.assertEqual(service.main([]), 1)
        self.assertIn("not started", str(output.call_args_list))


if __name__ == "__main__":
    unittest.main()
