import unittest

import numpy as np

from voice_signal_metrics import alignment, compare_signals, signal_stats


class SignalMetricsTests(unittest.TestCase):
    def test_positive_negative_offsets_and_unmatched_regions(self):
        source = np.random.default_rng(17).normal(0, .1, 80000)
        for lag in (1234, -777):
            upload = np.concatenate((np.zeros(lag), source, np.zeros(100))) if lag > 0 else source[-lag:]
            result = alignment(source, upload)
            self.assertEqual(result["lag_samples"], lag)
            self.assertAlmostEqual(result["correlation"], 1, places=10)
            self.assertTrue(result["reliable"])
            self.assertLess(result["residual_rms"], 1e-12)
            self.assertEqual(result["unmatched"]["source_prefix"], max(0, -lag))
            self.assertEqual(result["unmatched"]["upload_prefix"], max(0, lag))

    def test_negative_gain_dc_and_input_preservation(self):
        source = np.random.default_rng(18).normal(0, .1, 80000)
        upload = -.5 * source + .02
        before = source.copy(), upload.copy()
        result = alignment(source, upload)
        self.assertEqual(result["lag_samples"], 0)
        self.assertAlmostEqual(result["correlation"], -1, places=10)
        self.assertAlmostEqual(result["centered_gain"], -.5, places=10)
        self.assertGreater(result["residual_rms"], .1)
        np.testing.assert_array_equal(source, before[0])
        np.testing.assert_array_equal(upload, before[1])

    def test_unavailable_weak_periodic_and_boundary(self):
        for values in (np.zeros(80000), np.ones(80000) * .1):
            result = alignment(values, values)
            self.assertFalse(result["available"])
            self.assertIn("insufficient_energy", result["flags"])
            self.assertIsNone(result["lag_samples"])
        random = np.random.default_rng(19)
        source = random.normal(0, .1, 80000)
        self.assertIn("weak", alignment(source, random.normal(0, .1, 80000))["flags"])
        periodic = np.tile(random.normal(0, .1, 400), 200)
        self.assertIn("ambiguous", alignment(periodic, periodic)["flags"])
        upload = np.concatenate((np.zeros(16000), source))
        self.assertIn("search_boundary", alignment(source, upload)["flags"])
        self.assertFalse(alignment(source, upload)["reliable"])
        short = alignment(source, source[:16000], minimum_lag=-100, maximum_lag=-1, full_window=True)
        self.assertFalse(short["available"])
        self.assertIn("insufficient_overlap", short["flags"])

    def test_pcm_stats_rails_low_energy_edges_and_partial_frame(self):
        pcm = np.array([-32768, 32767] + [0] * 159, dtype=np.int16)
        stats = signal_stats(pcm)
        self.assertEqual(stats["negative_rail_samples"], 1)
        self.assertEqual(stats["positive_rail_samples"], 1)
        self.assertEqual(stats["near_rail_samples"], 2)
        self.assertEqual(stats["partial_frame_samples"], 1)
        zero = signal_stats(np.zeros(321, dtype=np.int16))
        self.assertIsNone(zero["rms_dbfs"])
        self.assertTrue(zero["zero_signal"])
        self.assertEqual(zero["low_energy"]["-60"]["frames"], 2)
        edge = signal_stats(np.concatenate((np.full(160, 32, dtype=np.int16), np.full(160, 33, dtype=np.int16))))
        self.assertEqual(edge["low_energy"]["-60"]["frames"], 1)
        self.assertEqual(edge["low_energy"]["-60"]["intervals"], [[0, 160]])
        self.assertEqual(edge["low_energy"]["-60"]["leading_samples"], 160)
        self.assertEqual(edge["low_energy"]["-60"]["trailing_samples"], 0)

    def test_local_offsets_detect_inserted_and_deleted_segments(self):
        source = np.random.default_rng(21).integers(-8000, 8000, 96000, dtype=np.int16)
        source[60000:] //= 4
        for shift in (120, -120):
            if shift > 0:
                upload = np.concatenate((source[:60000], source[59880:60000], source[60000:]))
            else:
                upload = np.concatenate((source[:60000], source[60120:]))
            result = compare_signals(source, upload)
            self.assertEqual([w["lag_samples"] for w in result["windows"]], [0, 0, shift])
            self.assertEqual(result["last_minus_first_samples"], shift)
            self.assertTrue(result["global"]["reliable"])

    def test_low_energy_local_windows_and_pcm_input_validation(self):
        source = np.zeros(96000, dtype=np.int16)
        source[40000:55000] = np.random.default_rng(22).integers(-8000, 8000, 15000, dtype=np.int16)
        result = compare_signals(source, source.copy())
        self.assertIsNone(result["last_minus_first_samples"])
        self.assertTrue(result["offset_consistency_reason"])
        for bad in (np.array([], dtype=np.int16), np.array([float("nan")]), np.ones((2, 2), dtype=np.int16)):
            with self.assertRaises(ValueError):
                signal_stats(bad)


if __name__ == "__main__":
    unittest.main()
