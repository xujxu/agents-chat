import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cpg_common as common
import cpg_launcher as launcher


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


if __name__ == "__main__":
    unittest.main()
