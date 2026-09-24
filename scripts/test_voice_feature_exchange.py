import copy
import hashlib
import math
import struct
import unittest

from voice_feature_data import extract_block, validate_feature, validate_pcm, validate_wav, numeric_difference
from voice_feature_report import exchange_report


class FeatureTests(unittest.TestCase):
    def test_source_extraction_requires_unique_pinned_anchors(self):
        block = "static const int FS=16000;\nstatic int compute_fbank(){\n  T_out=Tl; return out;\n}\n\n"
        source = "prefix\n" + block + "struct cfg { other"
        self.assertEqual(extract_block(source), block)
        for invalid in (source.replace("FS=16000", "FS=8000"), source + source,
                        source.replace("T_out=Tl; return out;", "return changed;")):
            with self.assertRaises(ValueError):
                extract_block(invalid)

    def test_strict_feature_pcm_and_wav_validation(self):
        n = 16000
        t = (((n - 400) // 160 + 1) + 5) // 6
        payload = struct.pack("<f", 1.0) * (t * 560)
        feature = struct.pack("<ii", t, 560) + payload
        self.assertEqual(len(validate_feature(feature, n)), t * 560)
        self.assertEqual(len(validate_pcm(struct.pack("<f", .5) * n, n)), n)
        for bad in (feature[:-1], feature + b"x", struct.pack("<ii", -1, 560) + payload,
                    struct.pack("<ii", 2**30, 560) + payload,
                    struct.pack("<ii", t, 559) + payload,
                    feature[:8] + struct.pack("<f", math.nan) + payload[4:]):
            with self.assertRaises(ValueError):
                validate_feature(bad, n)
        for bad in (b"", struct.pack("<f", math.inf) * n):
            with self.assertRaises(ValueError):
                validate_pcm(bad, n)
        wav = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36+n*2, b"WAVE", b"fmt ", 16,
                          1, 1, 16000, 32000, 2, 16, b"data", n*2) + b"\0" * (n*2)
        self.assertEqual(validate_wav(wav), n)
        for bad in (wav[:-1], wav+b"x", wav[:24]+struct.pack("<I", 8000)+wav[28:]):
            with self.assertRaises(ValueError):
                validate_wav(bad)
        self.assertEqual(numeric_difference([1., 2.], [1., 4.]),
                         {"elements": 2, "changed": 1, "max_abs": 2., "rms": math.sqrt(2.)})

    def fixture(self):
        samples = [{"id": f"s{i}", "reference": "reference", "category": "mixed",
                    "duration": 8., "split": "test", "dataset": "ASCEND",
                    "audio_sha256": hashlib.sha256(str(i).encode()).hexdigest()} for i in range(12)]
        rows = [{**s, "consumer": c, "repetition": r, "input_source": p,
                 "text": "same", "failure": None, "seconds": .1}
                for c in ("linux", "win32") for s in samples for r in (1, 2, 3)
                for p in ("wav", "linux", "win32")]
        history = {c: {s["id"]: "same" for s in samples} for c in ("linux", "win32")}
        return samples, rows, history

    def test_matrix_and_controls(self):
        samples, rows, history = self.fixture()
        result = exchange_report(samples, rows, history)
        self.assertEqual(result["delivered"], 216)
        self.assertTrue(result["controls_pass"])
        self.assertTrue(all(s["classification"] == "unchanged" for s in result["samples"]))
        for kind in ("missing", "duplicate", "identity", "time", "empty"):
            changed = copy.deepcopy(rows)
            if kind == "missing":
                changed.pop()
            elif kind == "duplicate":
                changed[-1] = changed[0]
            elif kind == "identity":
                changed[0]["audio_sha256"] = "bad"
            elif kind == "time":
                changed[0]["seconds"] = float("nan")
            else:
                changed[0]["text"] = ""
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                exchange_report(samples, changed, history)
        for kind in ("failure", "unstable", "history", "own"):
            changed, prior = copy.deepcopy(rows), copy.deepcopy(history)
            if kind == "failure":
                changed[0].update(text=None, failure="voice_timeout")
            elif kind == "unstable":
                changed[0]["text"] = "other"
            elif kind == "history":
                prior["linux"]["s0"] = "other"
            else:
                for row in changed:
                    if row["consumer"] == "linux" and row["input_source"] == "linux":
                        row["text"] = "other"
            with self.subTest(kind=kind):
                report = exchange_report(samples, changed, prior)
                self.assertFalse(report["controls_pass"])
                self.assertEqual(report["samples"][0]["classification"], "invalid-controls")

    def test_conditional_classifications(self):
        for mode in ("frontend-sufficient", "downstream", "mixed"):
            samples, rows, history = self.fixture()
            for row in rows:
                c, p = row["consumer"], row["input_source"]
                source = c if p == "wav" else p
                row["text"] = source if mode == "frontend-sufficient" else c if mode == "downstream" else c+source
            for c in history:
                history[c] = {s["id"]: c+c if mode == "mixed" else c for s in samples}
            report = exchange_report(samples, rows, history)
            self.assertTrue(report["controls_pass"])
            self.assertTrue(all(s["classification"] == mode for s in report["samples"]))


if __name__ == "__main__":
    unittest.main()
