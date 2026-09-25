import unittest

import numpy as np

from voice_graph_metrics import envelope, finite, marker, quantize, tones


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


if __name__ == "__main__":
    unittest.main()
