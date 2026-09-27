"""Caption-led candidates only, not verified bilingual speech or reference text."""

import hashlib

from voice_long_selection import describe


def windows(video):
    utterances = []
    for key, text in video["text"].items():
        fields = key.rsplit("-", 2)
        start, end = int(fields[-2]) / 100, int(fields[-1]) / 100
        if not 0 <= start < end:
            raise ValueError(f"Invalid caption timestamps: {key}")
        utterances.append({"id": key, "start": start, "end": end, "text": text})
    utterances.sort(key=lambda u: (u["start"], u["end"]))
    result = []
    for i, first in enumerate(utterances):
        group = []
        for utterance in utterances[i:]:
            if utterance["end"] - first["start"] > 30:
                break
            if group and utterance["start"] - group[-1]["end"] > 3:
                break
            group.append(utterance)
            duration = utterance["end"] - first["start"]
            caption = " ".join(u["text"] for u in group)
            features = describe({"duration": duration, "transcription": caption})
            if features and features["english_words"] >= 3 and features["chinese_characters"] >= 10:
                result.append({
                    "video": video["audio_id"], "start": first["start"],
                    "end": utterance["end"], "duration": duration,
                    "caption": caption, "caption_ids": [u["id"] for u in group],
                    **features,
                })
    return result


def choose(candidates, count=40):
    def rank(candidate):
        identity = f"{candidate['shard']}:{candidate['video']}:{candidate['start']}:{candidate['end']}"
        return hashlib.sha256(identity.encode()).hexdigest()

    selected, used = [], {}
    for candidate in sorted(candidates, key=rank):
        key = (candidate["shard"], candidate["video"])
        previous = used.setdefault(key, [])
        if len(previous) >= 2 or any(
                candidate["start"] < other["end"] and candidate["end"] > other["start"]
                for other in previous):
            continue
        selected.append(candidate)
        previous.append(candidate)
        if len(selected) == count:
            break
    return selected
