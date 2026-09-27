import unittest

from voice_model_notices import weight_evidence


class NoticeTests(unittest.TestCase):
    def test_explicit_license_and_identical_published_weight(self):
        result = weight_evidence({"License": "apache-2.0"},
                                 [{"Path": "model.onnx", "Sha256": "a" * 64, "Revision": "revision"}],
                                 {"qwen/model.onnx": "a" * 64}, {"qwen/model.onnx": "model.onnx"})
        self.assertTrue(result["weights_matched"])
        self.assertFalse(result["complete_package_approved"])

    def test_different_hash_is_reported_not_silently_accepted(self):
        result = weight_evidence({"License": "apache-2.0"},
                                 [{"Path": "model.onnx", "Sha256": "a" * 64, "Revision": "revision"}],
                                 {"qwen/model.onnx": "b" * 64}, {"qwen/model.onnx": "model.onnx"})
        self.assertFalse(result["weights_matched"])

    def test_missing_or_non_whitelist_license_fails_closed(self):
        for metadata in ({}, {"License": "other"}, {"License": ""}):
            with self.assertRaises(ValueError):
                weight_evidence(metadata, [], {}, {})

    def test_missing_requested_file_fails_closed(self):
        with self.assertRaises(ValueError):
            weight_evidence({"License": "apache-2.0"}, [], {}, {"qwen/model.onnx": "model.onnx"})


if __name__ == "__main__":
    unittest.main()
