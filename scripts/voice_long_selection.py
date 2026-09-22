"""Select real 15-30 second mixed utterances, without concatenation or padding."""

import hashlib
import itertools
import re

from voice_accuracy_metrics import language, tokens


def describe(row):
    text = row["transcription"]
    if not 15 <= row["duration"] <= 30 or re.search(r"[\[\]<>]", text):
        return None
    languages = [language(token) for token in tokens(text)]
    if "en" not in languages or "zh" not in languages:
        return None
    runs = [(lang, len(list(group))) for lang, group in itertools.groupby(languages)]
    return {
        "english_words": languages.count("en"),
        "chinese_characters": languages.count("zh"),
        "longest_english_run": max(count for lang, count in runs if lang == "en"),
        "switches": sum({left, right} == {"en", "zh"} for left, right in zip(languages, languages[1:])),
    }


def select(rows, count=40):
    priority = {"test": 0, "validation": 1, "train": 2}
    return sorted(
        (row for row in rows if describe(row) is not None),
        key=lambda row: (
            priority[row["split"]],
            hashlib.sha256(f"natural-long-v1:{row['split']}:{row['id']}".encode()).hexdigest(),
        ),
    )[:count]
