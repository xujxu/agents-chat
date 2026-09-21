import unittest

from voice_accuracy_metrics import score, tokens


class AccuracyMetricsTests(unittest.TestCase):
    def test_mixed_tokenization(self):
        self.assertEqual(tokens("你好，Hello WORLD!"), ["你", "好", "hello", "world"])

    def test_normalization_is_not_semantic_correction(self):
        self.assertEqual(tokens("開放，ＡＢＣ！"), ["开", "放", "abc"])
        self.assertNotEqual(tokens("gold"), tokens("code"))
        self.assertNotEqual(tokens("50"), tokens("fifty"))

    def test_exact_match(self):
        result = score("我like apples", "我 like apples.")
        self.assertEqual(result["errors"], 0)
        self.assertEqual(result["reference_tokens"], 3)
        self.assertEqual(result["boundary_tokens"], 2)

    def test_deleted_english_span(self):
        result = score("我like apples今天", "我今天")
        self.assertEqual(result["deletions"], 2)
        self.assertEqual(result["en_sd"], 2)
        self.assertEqual(result["zh_sd"], 0)
        self.assertEqual(result["errors"], 2)

    def test_substitution_insertion(self):
        result = score("我like gold", "我 like code now")
        self.assertEqual(result["substitutions"], 1)
        self.assertEqual(result["insertions"], 1)
        self.assertEqual(result["errors"], 2)

    def test_empty_speech_and_silence_hallucination(self):
        self.assertEqual(score("你好", "")["deletions"], 2)
        result = score("", "我")
        self.assertEqual(result["reference_tokens"], 0)
        self.assertEqual(result["insertions"], 1)
        self.assertIsNone(result["mer"])


if __name__ == "__main__":
    unittest.main()
