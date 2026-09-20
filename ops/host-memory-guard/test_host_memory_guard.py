import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("host_memory_guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
MIB = 1024 * 1024


def healthy_group(**changes):
    result = {
        "unit": "user-1001.slice", "limit_bytes": guard.LIMIT,
        "usage_bytes": 700 * MIB, "working_set_bytes": 400 * MIB,
        "hierarchy": 1, "oom": {"oom_kill_disable": 0, "oom_kill": 0},
        "failcnt": 0,
    }
    result.update(changes)
    return result


class GuardTests(unittest.TestCase):
    def test_host_thresholds_exact(self):
        self.assertEqual(guard.alert_reasons(512 * MIB, []), [])
        self.assertIn("WARNING", guard.alert_reasons(512 * MIB - 1, [])[0])
        self.assertIn("WARNING", guard.alert_reasons(256 * MIB, [])[0])
        self.assertIn("CRITICAL", guard.alert_reasons(256 * MIB - 1, [])[0])

    def test_group_thresholds_use_working_set_not_reclaimable_cache(self):
        group = healthy_group(usage_bytes=guard.LIMIT)
        self.assertEqual(guard.alert_reasons(1000 * MIB, [group]), [])
        for percent, severity in ((80, "WARNING"), (95, "CRITICAL")):
            group = healthy_group(working_set_bytes=guard.LIMIT * percent // 100)
            self.assertIn(severity, guard.alert_reasons(1000 * MIB, [group])[0])
        group = healthy_group(working_set_bytes=guard.LIMIT * 80 // 100 - 1)
        self.assertEqual(guard.alert_reasons(1000 * MIB, [group]), [])

    def test_boundary_drift_is_critical(self):
        for changes in (
            {"limit_bytes": 2 * guard.LIMIT}, {"limit_bytes": guard.LIMIT - 1},
            {"hierarchy": 0}, {"oom": {"oom_kill_disable": 1}},
        ):
            self.assertIn("containment missing", guard.alert_reasons(2000 * MIB, [healthy_group(**changes)])[0])

    def test_files_persist_limits_without_touching_existing_runtime_override(self):
        files = guard.config_files(1001, b"script\n")
        self.assertEqual(len(files), 5)
        self.assertTrue(all("runtime.conf" not in str(p) for p in files))
        user = files[Path("/etc/systemd/system/user-1001.slice.d/70-host-memory-guard.conf")]
        self.assertIn(b"MemoryMax=1536M", user)
        self.assertNotIn(b"MemoryHigh", user)
        prod = files[Path("/etc/systemd/system/agents-chat.service.d/70-host-memory-guard.conf")]
        self.assertIn(b"StartLimitIntervalSec=300", prod)
        self.assertIn(b"StartLimitBurst=3", prod)

    def test_atomic_write_private_mode_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state.json"
            guard.write_file(target, b'{"ok":true}', 0o600)
            self.assertEqual(json.loads(target.read_text()), {"ok": True})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            link = Path(directory) / "link"
            link.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                guard.write_file(link, b"bad")
            self.assertEqual(target.read_bytes(), b'{"ok":true}')

    def test_preflight_refuses_root_low_memory_and_existing_files(self):
        with self.assertRaisesRegex(RuntimeError, "root account"):
            guard.preflight(0, {})
        with patch.object(guard.pwd, "getpwuid"), patch.object(guard, "memory_info", return_value=(3914 * MIB, 700 * MIB)):
            with self.assertRaisesRegex(RuntimeError, "headroom"):
                guard.preflight(1001, {})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "existing"
            path.write_text("keep")
            with patch.object(guard.pwd, "getpwuid"), patch.object(guard, "memory_info", return_value=(3914 * MIB, 2000 * MIB)):
                with self.assertRaisesRegex(RuntimeError, "overwrite"):
                    guard.preflight(1001, {path: b"replacement"})

    def test_preflight_rejects_live_reclaim_and_weakened_limit(self):
        prop = {"LoadState": "loaded", "ActiveState": "active", "MemoryMax": "infinity"}
        for group, message in (
            (healthy_group(usage_bytes=guard.LIMIT - guard.MARGIN), "too close"),
            (healthy_group(limit_bytes=1024 * MIB), "weaken"),
            (healthy_group(hierarchy=0), "Hierarchical"),
        ):
            with patch.object(guard.pwd, "getpwuid"), patch.object(guard, "memory_info", return_value=(3914 * MIB, 2000 * MIB)), \
                    patch.object(guard, "properties", return_value=prop), patch.object(guard, "group_state", return_value=group):
                with self.assertRaisesRegex(RuntimeError, message):
                    guard.preflight(1001, {})

    def test_rollback_refuses_edited_config_before_any_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            path.write_text("modified")
            state = {"files": {str(path): guard.digest(b"original")}}
            with patch.object(guard, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "modified"):
                    guard.restore(state)
                run.assert_not_called()
            self.assertEqual(path.read_text(), "modified")

    def test_verify_checks_real_kernel_not_only_systemd_setting(self):
        state = {"before": {"user-1001.slice": {}}, "files": {}}
        prop = {"ActiveState": "active", "MemoryMax": str(guard.LIMIT)}
        with patch.object(guard, "properties", return_value=prop), \
                patch.object(guard, "group_state", return_value=healthy_group(limit_bytes=2**63 - 4096)):
            with self.assertRaisesRegex(RuntimeError, "Kernel"):
                guard.verify(state)

    def test_verify_accepts_installed_boundary_and_unchanged_prod(self):
        state = {
            "before": {"user-1001.slice": {"MainPID": "0", "oom_kill": 0}},
            "files": {},
        }
        prop = {
            "ActiveState": "active", "MemoryMax": str(guard.LIMIT), "MainPID": "0",
            "StartLimitBurst": "3", "StartLimitIntervalUSec": "5min",
        }
        with patch.object(guard, "properties", return_value=prop), \
                patch.object(guard, "group_state", return_value=healthy_group()):
            self.assertEqual(len(guard.verify(state, require_same_pid=True)), 1)
        for field, value, message in (
            ("MainPID", "123", "restart"), ("StartLimitBurst", "5", "restart rate"),
        ):
            with patch.object(guard, "properties", return_value=dict(prop, **{field: value})), \
                    patch.object(guard, "group_state", return_value=healthy_group()):
                with self.assertRaisesRegex(RuntimeError, message):
                    guard.verify(state, require_same_pid=True)

    def test_scoped_rollback_restores_original_limit_without_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "owned"
            file.write_bytes(b"approved")
            state = {
                "files": {str(file): guard.digest(b"approved")},
                "before": {"user-1001.slice": {"MemoryMax": "infinity", "kernel_limit": 2**63 - 4096}},
            }
            with patch.object(guard, "properties", return_value={"LoadState": "loaded"}), \
                    patch.object(guard, "group_state", return_value={"limit_bytes": 2**63 - 4096}), \
                    patch.object(guard, "save_state") as save, patch.object(guard, "run") as run:
                guard.restore(state)
                self.assertFalse(file.exists())
                self.assertEqual(state["phase"], "rolled_back")
                save.assert_called_once_with(state)
                run.assert_any_call("systemctl", "set-property", "--runtime", "user-1001.slice", "MemoryMax=infinity")
                self.assertTrue(all("restart" not in call.args for call in run.call_args_list))

    def test_failed_live_application_rolls_back_owned_files_and_previous_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owned = root / "owned.conf"
            before = {"user-1001.slice": {"MemoryMax": "infinity", "kernel_limit": 2**63 - 4096}}
            commands = []

            def command(*args):
                commands.append(args)
                if args[-1] == "MemoryMax=" + str(guard.LIMIT):
                    raise RuntimeError("injected live application failure")
                return ""

            with patch.object(guard, "require_root"), \
                    patch.object(guard, "STATE", root / "state"), \
                    patch.object(guard, "INSTALLATION", root / "state" / "installation.json"), \
                    patch.object(guard, "config_files", return_value={owned: b"approved"}), \
                    patch.object(guard, "preflight", return_value=before), \
                    patch.object(guard, "run", side_effect=command), \
                    patch.object(guard, "properties", return_value={"LoadState": "not-found"}), \
                    patch.object(guard, "group_state", return_value={"limit_bytes": 2**63 - 4096}):
                with self.assertRaisesRegex(RuntimeError, "injected"):
                    guard.install(1001)
                state = json.loads(guard.INSTALLATION.read_text())
                self.assertEqual(state["phase"], "rolled_back")
                self.assertFalse(owned.exists())
                self.assertIn(("systemctl", "set-property", "--runtime", "user-1001.slice", "MemoryMax=infinity"), commands)
                self.assertTrue(all("restart" not in args for args in commands))

    def test_monitor_rate_limits_and_reports_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = {
                "phase": "installed", "boot_id": "same-boot",
                "before": {"user-1001.slice": {"oom_kill": 0}, guard.SERVICE: {"oom_kill": 0}},
            }
            with patch.object(guard, "require_root"), \
                    patch.object(guard, "ALERT_STATE", root / "alert.json"), \
                    patch.object(guard, "load_state", return_value=state), \
                    patch.object(guard, "boot_id", return_value="same-boot"), \
                    patch.object(guard.time, "time", side_effect=[1000, 1030, 1300, 1330]), \
                    patch.object(guard, "memory_info", side_effect=[(3914 * MIB, 300 * MIB)] * 3 + [(3914 * MIB, 2000 * MIB)]), \
                    patch.object(guard, "properties", return_value={"ActiveState": "inactive"}), \
                    patch.object(guard, "run") as run:
                guard.monitor()
                self.assertEqual(run.call_count, 1)
                self.assertIn("PROD service is not active", run.call_args.kwargs["input"])
                guard.monitor()
                self.assertEqual(run.call_count, 1)
                guard.monitor()
                self.assertEqual(run.call_count, 2)
                with patch.object(guard, "properties", return_value={"ActiveState": "active"}), \
                        patch.object(guard, "group_state", return_value=healthy_group()):
                    guard.monitor()
                self.assertEqual(run.call_count, 2)
                self.assertEqual(json.loads(guard.ALERT_STATE.read_text())["signature"], "")


if __name__ == "__main__":
    unittest.main()
