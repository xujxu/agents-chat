import os
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cpg_common as common
import cpg_launcher as launcher
import cpg_admin as admin


class GuardTests(unittest.TestCase):
    def test_only_memory_hierarchy_is_selected(self):
        text = "12:pids:/user.slice/login\n8:memory:/cpg-cli\n0::/user.slice/login\n"
        self.assertEqual(common.memory_membership(text), "/cpg-cli")
        with self.assertRaisesRegex(RuntimeError, "v1"):
            common.memory_membership("0::/user.slice/login\n")

    def test_hard_limit_is_exactly_1536_mib(self):
        self.assertEqual(common.LIMIT, 1610612736)
        healthy = {"limit": common.LIMIT, "hierarchy": 1, "oom_disabled": 0}
        common.verify_boundary(healthy)
        for field, value in (("limit", common.LIMIT * 2), ("hierarchy", 0), ("oom_disabled", 1)):
            with self.assertRaises(RuntimeError):
                common.verify_boundary(dict(healthy, **{field: value}))

    def test_oom_victims_are_counted_across_delegated_children(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / common.WORKLOAD
            child.mkdir()
            (root / "memory.oom_control").write_text("oom_kill_disable 0\noom_kill 2\n")
            (child / "memory.oom_control").write_text("oom_kill_disable 0\noom_kill 3\n")
            (root / "memory.stat").write_text("total_inactive_file 0\n")
            for name, value in (
                ("limit_in_bytes", common.LIMIT), ("usage_in_bytes", 100),
                ("use_hierarchy", 1), ("failcnt", 0),
            ):
                (root / ("memory." + name)).write_text(str(value))
            with patch.object(common, "GROUP", root):
                self.assertEqual(common.read_group()["oom_kills"], 5)

    def test_pressure_thresholds_and_cache_semantics(self):
        group = {"usage": common.LIMIT, "inactive_file": common.LIMIT, "oom_kills": 0}
        self.assertEqual(common.pressure_reasons(512 * common.MIB, group), [])
        self.assertIn("WARNING", common.pressure_reasons(512 * common.MIB - 1, group)[0])
        self.assertIn("CRITICAL", common.pressure_reasons(256 * common.MIB - 1, group)[0])
        group["inactive_file"] = 0
        group["usage"] = common.LIMIT * 80 // 100
        self.assertIn("WARNING", common.pressure_reasons(1024 * common.MIB, group)[0])
        group["usage"] = common.LIMIT * 95 // 100
        self.assertIn("CRITICAL", common.pressure_reasons(1024 * common.MIB, group)[0])

    def test_configuration_rejects_root_relative_binary_and_invalid_mode(self):
        config = {"schema": 1, "uid": 1001, "gid": 1001, "executable": "/home/test/copilot", "enabled": True}
        common.validate_config(config)
        for changes in (
            {"uid": 0}, {"uid": "1001"}, {"gid": -1},
            {"executable": "copilot"}, {"enabled": "yes"}, {"schema": 2},
        ):
            with self.assertRaises(RuntimeError):
                common.validate_config(dict(config, **changes))

    def test_atomic_config_modes_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            common.write_json(path, {"enabled": True}, 0o600)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(RuntimeError):
                common.write_json(link, {}, 0o600)
            self.assertEqual(common.read_json(path), {"enabled": True})

    def test_launcher_never_starts_as_root_or_another_user(self):
        config = {"uid": 1001, "enabled": True, "executable": "/bin/true"}
        for uid in (0, 1002):
            with patch.object(os, "getuid", return_value=uid), patch.object(os, "fork") as fork:
                with self.assertRaisesRegex(RuntimeError, "user"):
                    launcher.run(config, ["--yolo"])
                fork.assert_not_called()

    def test_disabled_launcher_warns_and_preserves_literal_arguments(self):
        config = {"uid": 1001, "enabled": False, "executable": "/bin/copilot"}
        args = ["--yolo", "--model", "a b", "$(not-a-command)", ""]
        with patch.object(os, "getuid", return_value=1001), \
                patch.object(os, "execv") as execute, patch("builtins.print") as output:
            launcher.run(config, args)
            execute.assert_called_once_with("/bin/copilot", ["/bin/copilot"] + args)
            self.assertIn("DISABLED", output.call_args.args[0])

    def test_sampling_refuses_disabled_guard_before_launch(self):
        config = {"uid": 1001, "enabled": False, "executable": "/bin/copilot"}
        with patch.object(os, "getuid", return_value=1001), \
                patch.object(os, "execv") as execute:
            with self.assertRaisesRegex(RuntimeError, "enabled"):
                launcher.run(config, ["--memory-sampling", "--yolo"])
            execute.assert_not_called()

    def test_only_leading_sampling_option_is_consumed(self):
        config = {"uid": 1001, "enabled": False, "executable": "/bin/copilot"}
        args = ["-p", "--memory-sampling"]
        with patch.object(os, "getuid", return_value=1001), patch.object(os, "execv") as execute:
            launcher.run(config, args)
            execute.assert_called_once_with("/bin/copilot", ["/bin/copilot"] + args)

    def test_sampling_child_executes_original_binary_with_literal_arguments(self):
        import memory_sampler_launch as runtime
        config = {"uid": 1001, "enabled": True, "executable": "/original/copilot"}
        group = {"usage": 0}
        environment = {"CPG_MEMORY_PID": "123"}
        args = ["--memory-sampling", "--yolo", "-p", "literal $(text)"]
        with ExitStack() as stack:
            stack.enter_context(patch.object(os, "getuid", return_value=1001))
            stack.enter_context(patch.object(os, "getpid", return_value=123))
            stack.enter_context(patch.object(common, "read_group", return_value=group))
            stack.enter_context(patch.object(common, "verify_boundary"))
            stack.enter_context(patch.object(common, "memory_info", return_value=(4 * common.LIMIT, common.LIMIT)))
            stack.enter_context(patch.object(common, "memory_membership",
                                            side_effect=["/outside", common.WORKLOAD_PATH]))
            stack.enter_context(patch.object(os, "fork", return_value=0))
            stack.enter_context(patch.object(os, "pipe", return_value=(100, 101)))
            stack.enter_context(patch.object(os, "close"))
            stack.enter_context(patch.object(os, "write"))
            stack.enter_context(patch.object(launcher.subprocess, "run"))
            stack.enter_context(patch.object(runtime, "check_preload"))
            stack.enter_context(patch.object(runtime, "check_collector"))
            prepare = stack.enter_context(patch.object(runtime, "environment", return_value=environment))
            execute = stack.enter_context(patch.object(os, "execve", side_effect=SystemExit(0)))
            with self.assertRaises(SystemExit):
                launcher.run(config, args)
            prepare.assert_called_once_with(1001, 123, executable=config["executable"])
            execute.assert_called_once_with(config["executable"],
                [config["executable"], runtime.node_option(), *args[1:]], environment)

    def test_launcher_upgrade_changes_only_code_and_record_hashes(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            for name, path in (("LAUNCHER", root / "cpg"), ("ADMIN", root / "cpgctl"),
                               ("RECORD", root / "record"), ("LIB", root)):
                stack.enter_context(patch.object(common, name, path))
            source = Path(admin.__file__).parent
            (root / "cpg_common.py").write_bytes((source / "cpg_common.py").read_bytes())
            common.LAUNCHER.write_bytes(b"old-launcher")
            common.ADMIN.write_bytes(b"old-admin")
            value = {"phase": "installed", "files": {"untouched-unit": "keep"}, "config": {"uid": 1001}}
            stack.enter_context(patch.object(admin, "check_files"))
            control = stack.enter_context(patch.object(admin, "systemctl"))
            admin.upgrade_launcher(value)
            result = common.read_json(common.RECORD)
            self.assertEqual(result["files"]["untouched-unit"], "keep")
            self.assertEqual(result["files"][str(common.LAUNCHER)],
                             admin.fingerprint(common.LAUNCHER.read_bytes()))
            self.assertIn(b"--memory-sampling", common.LAUNCHER.read_bytes())
            self.assertEqual(result["config"], value["config"])
            control.assert_not_called()
            value = result
            originals = {path: path.read_bytes() for path in (common.LAUNCHER, common.ADMIN)}
            write = common.write_json
            calls = []

            def fail_after_record_replace(path, data, mode):
                write(path, data, mode)
                calls.append(path)
                if len(calls) == 1:
                    raise OSError("injected post-rename failure")

            with patch.object(common, "write_json", side_effect=fail_after_record_replace):
                with self.assertRaisesRegex(OSError, "injected"):
                    admin.upgrade_launcher(value)
            self.assertEqual(common.read_json(common.RECORD), value)
            self.assertTrue(all(path.read_bytes() == content for path, content in originals.items()))

    def test_installed_assets_do_not_modify_applications_or_sudo_policy(self):
        package = admin.files(Path(__file__).resolve().parent, 1001, 1001)
        self.assertEqual(len(package), 8)
        for path in package:
            self.assertNotIn("agents-chat", str(path))
            self.assertNotIn("user-", str(path))
            self.assertNotIn("sudoers", str(path))
        monitor = package[admin.UNITS / admin.MONITOR]
        self.assertIn(b"MemoryMax=32M", monitor)
        self.assertIn(b"CPUQuota=5%", monitor)

    def test_partial_install_failure_removes_only_new_files(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            paths = {
                "CONFIG": root / "etc/cpg/config.json",
                "STATE": root / "state/cpg",
                "RECORD": root / "state/cpg/installation.json",
                "LIB": root / "lib/cpg",
                "ADMIN": root / "sbin/cpgctl",
                "LAUNCHER": root / "bin/cpg",
                "GROUP": root / "memory/cpg-cli",
                "LOCK": root / "lock",
            }
            for name, path in paths.items():
                stack.enter_context(patch.object(common, name, path))
            common.LOCK.write_text("")
            binary = root / "copilot"
            binary.write_text("#!/bin/sh\nexit 0\n")
            binary.chmod(0o755)
            unrelated = root / "unrelated"
            unrelated.write_text("keep")
            package = {common.LAUNCHER: b"launcher", common.ADMIN: b"admin"}
            stack.enter_context(patch.object(admin, "files", return_value=package))
            stack.enter_context(patch.object(common, "memory_info", return_value=(4096 * common.MIB, 2048 * common.MIB)))
            stack.enter_context(patch.object(common, "memory_membership", return_value="/outside"))
            stack.enter_context(patch.object(admin.pwd, "getpwuid", return_value=type("User", (), {"pw_gid": 1001})()))
            stack.enter_context(patch.object(admin, "configure_group", side_effect=RuntimeError("injected setup failure")))
            stack.enter_context(patch.object(admin, "stop_units"))
            control = stack.enter_context(patch.object(admin, "systemctl"))
            with self.assertRaisesRegex(RuntimeError, "injected setup failure"):
                admin.install(1001, str(binary))
            self.assertFalse(common.LAUNCHER.exists())
            self.assertFalse(common.ADMIN.exists())
            self.assertFalse(common.CONFIG.exists())
            self.assertFalse(common.RECORD.exists())
            self.assertTrue(binary.exists())
            self.assertEqual(unrelated.read_text(), "keep")
            self.assertTrue(all("restart" not in call.args for call in control.call_args_list))


if __name__ == "__main__":
    unittest.main()
