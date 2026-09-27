import unittest

from voice_public_windows import choose, windows


class PublicWindowTests(unittest.TestCase):
    def test_window_uses_original_timeline_including_pause(self):
        video = {"audio_id": "a", "text": {
            "a-00000-00000000-00001000": "我们今天准备讨论 I want to swim",
            "a-00001-00001200-00002000": "然后回家吃晚饭",
        }}
        result = windows(video)
        self.assertEqual(len(result), 1)
        self.assertEqual((result[0]["start"], result[0]["end"]), (0, 20))

    def test_large_gap_is_not_joined_into_a_candidate(self):
        video = {"audio_id": "a", "text": {
            "a-00000-00000000-00001000": "我们今天准备讨论 I want to swim",
            "a-00001-00014000-00015000": "然后回家吃晚饭",
        }}
        self.assertEqual(windows(video), [])

    def test_nonoverlap_and_video_cap(self):
        rows = [{"shard": "0", "video": "a", "start": start, "end": start + 20}
                for start in (0, 5, 10, 30, 60, 90)]
        result = choose(rows)
        self.assertEqual(len(result), 2)
        self.assertTrue(result[0]["end"] <= result[1]["start"] or result[1]["end"] <= result[0]["start"])
        self.assertEqual(result, choose(list(reversed(rows))))


if __name__ == "__main__":
    unittest.main()
