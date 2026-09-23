"""Evidence gates for the isolated native profiler experiment."""
import unittest
import resource
from pathlib import Path
from unittest.mock import patch

from native_probe_report import MIB, assess, parse_stacks, stack_bytes, overhead
from native_probe_capture import profiler_paths, trace_file_limit


class ReportTests(unittest.TestCase):
    def test_traced_files_keep_the_tighter_limit(self):
        with patch("native_probe_capture.resource.setrlimit") as limit:
            trace_file_limit()
            limit.assert_called_once_with(resource.RLIMIT_FSIZE, (64 * MIB, 64 * MIB))

    def test_profiler_paths_require_unambiguous_existing_package_files(self):
        listing = "/usr/lib/heaptrack/libheaptrack_preload.so\n/usr/lib/heaptrack/heaptrack_interpret\n"
        with patch("native_probe_capture.subprocess.check_output", return_value=listing) as query, \
                patch.object(Path, "is_file", return_value=True):
            self.assertEqual(profiler_paths()["heaptrack_interpret"],
                             "/usr/lib/heaptrack/heaptrack_interpret")
            query.assert_called_once_with(["dpkg-query", "-L", "libheaptrack"], text=True, timeout=10)
        for invalid in ("", listing + listing):
            with patch("native_probe_capture.subprocess.check_output", return_value=invalid), \
                    patch.object(Path, "is_file", return_value=True), self.assertRaises(RuntimeError):
                profiler_paths()

    def test_folded_stacks_preserve_function_spaces_and_sum(self):
        rows = parse_stacks("main;cpg_probe_keep (fixture.c); 16777216\n"
                            "main;cpg_probe_keep (fixture.c); 4096\n"
                            "main;cpg_probe_release; 0\n")
        self.assertEqual(stack_bytes(rows, "cpg_probe_keep"), 16 * MIB + 4096)
        self.assertEqual(stack_bytes(rows, "cpg_probe_release"), 0)

    def test_empty_and_malformed_evidence_is_not_success(self):
        for text in ("", "\n", "main;foo;", "main;foo; -1", "main;foo; nan"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_stacks(text)

    def test_unknown_addresses_do_not_count_as_named_attribution(self):
        rows = parse_stacks("0x123;0x456; 33554432\n")
        self.assertEqual(stack_bytes(rows, "ArrayBuffer"), 0)

    def test_overhead_uses_paired_medians_and_real_elapsed_time(self):
        baseline = [{"cpu_seconds": 1, "wall_seconds": 10, "max_rss_bytes": 100 * MIB}] * 3
        tracked = [{"cpu_seconds": 1.2, "wall_seconds": 10, "max_rss_bytes": 110 * MIB}] * 3
        result = overhead(baseline, tracked)
        self.assertAlmostEqual(result["extra_one_core_cpu_percent"], 2)
        self.assertEqual(result["extra_peak_rss_bytes"], 10 * MIB)
        self.assertEqual(result["wall_ratio"], 1)

    def test_missing_overhead_replicates_are_rejected(self):
        with self.assertRaises(ValueError):
            overhead([], [])

    def test_passing_synthetic_gates_does_not_claim_production_or_root_cause(self):
        result = assess(True, 32 * MIB, True, {
            "extra_one_core_cpu_percent": 2,
            "extra_peak_rss_bytes": 10 * MIB, "wall_ratio": 1.1,
        })
        self.assertTrue(result["synthetic_gates_passed"])
        self.assertFalse(result["production_ready"])
        self.assertFalse(result["root_cause_proven"])

    def test_every_missing_gate_blocks_replay_candidate(self):
        good = {"extra_one_core_cpu_percent": 2,
                "extra_peak_rss_bytes": 10 * MIB, "wall_ratio": 1}
        cases = [(False, 32 * MIB, True, good),
                 (True, 0, True, good),
                 (True, 32 * MIB, False, good)]
        for key, value in [("extra_one_core_cpu_percent", 5),
                           ("extra_peak_rss_bytes", 32 * MIB),
                           ("wall_ratio", 1.25)]:
            cases.append((True, 32 * MIB, True, dict(good, **{key: value})))
        for args in cases:
            with self.subTest(args=args):
                result = assess(*args)
                self.assertFalse(result["synthetic_gates_passed"])
                self.assertTrue(result["failed_gates"])


if __name__ == "__main__":
    unittest.main()
