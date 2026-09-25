import unittest

import numpy as np

from voice_graph_metrics import describe, envelope, finite, marker, quantize, stats, tones


class GraphMetricsTests(unittest.TestCase):
    def test_pcm_rounding_and_preservation(self):
        values = np.array([-1, -.5, 0, .5, 1], dtype=np.float32)
        before = values.copy()
        self.assertEqual(quantize(values).tolist(), [-32768, -16384, 0, 16384, 32767])
        np.testing.assert_array_equal(values, before)
        for bad in [np.array([]), np.array([np.nan]), np.array([np.inf])]:
            with self.assertRaises(ValueError):
                finite(bad)

    def test_fractional_envelope(self):
        np.testing.assert_allclose(envelope(np.ones(4410), 44100), np.ones(100), atol=1e-12)
        self.assertEqual(len(envelope(np.ones(4453), 44100)), 100)
        np.testing.assert_allclose(envelope(np.array([0., 1., 0.]), 1500),
                                   np.sqrt([1 / 3, 1 / 3]), atol=1e-12)

    def test_tone_phase_and_dc(self):
        rate = 44100
        time = np.arange(rate * 6) / rate
        values = .04 * np.sin(2 * np.pi * 250 * time + .7) + .02
        result = tones(values, rate, [250, 1000, 3000])
        self.assertAlmostEqual(result["amplitudes"]["250"], .04, places=10)
        self.assertAlmostEqual(result["amplitudes"]["1000"], 0, places=10)
        self.assertAlmostEqual(result["dc"], .02, places=10)
        self.assertLess(result["residual_rms"], 1e-10)
        with self.assertRaises(ValueError):
            tones(values[:10], rate, [250])

    def test_marker_delay_and_flags(self):
        rng = np.random.default_rng(730)
        template = rng.uniform(.01, .1, 200)
        signal = np.zeros(4000)
        signal[1123:1323] = template
        result = marker(template, signal, 1000)
        self.assertEqual(result["offset_ms"], 123)
        self.assertTrue(result["reliable"])
        signal[1600:1800] = template
        self.assertIn("ambiguous", marker(template, signal, 1000)["flags"])
        self.assertIn("zero_variance", marker(np.zeros(200), signal, 1000)["flags"])
        boundary = np.zeros(4000)
        boundary[2000:2200] = template
        self.assertIn("search_boundary", marker(template, boundary, 1000)["flags"])
        weak = rng.uniform(.01, .1, 4000)
        self.assertIn("weak", marker(template, weak, 1000)["flags"])

    def test_zero_and_signed_rails(self):
        result = stats(np.zeros(16000), 16000)
        self.assertTrue(result["zero_signal"])
        self.assertIsNone(result["rms_dbfs"])
        rails = stats(np.array([-1, 32767 / 32768, .99, 0]), 16000, True)
        self.assertEqual([rails[key] for key in ("negative_rail", "positive_rail", "near_rail")], [1, 1, 3])

    def test_cross_grid_markers_and_shifted_interval(self):
        rng = np.random.default_rng(732)
        templates = [np.repeat(rng.choice([.04, .12], 40), 5) for _ in range(3)]
        for rate in (16000, 44100, 48000):
            samples = np.zeros(rate * 9)
            for template, start in zip(templates, (1100, 4100, 7120)):
                left = round(start * rate / 1000)
                count = rate // 5
                indices = np.minimum(199, np.floor(np.arange(count) * 1000 / rate).astype(int))
                samples[left:left+count] = template[indices]
            result = describe(samples, rate, "mono-markers", templates)
            self.assertEqual([row["offset_ms"] for row in result["markers"]], [100, 100, 120])
            self.assertEqual([row["delta_ms"] for row in result["intervals"]], [0, 20])
        silent = describe(np.zeros(128000), 16000, "mono-markers", templates)
        self.assertEqual(silent["intervals"][0], {"delta_ms": None, "reason": "unreliable_marker"})


if __name__ == "__main__":
    unittest.main()
