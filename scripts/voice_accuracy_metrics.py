"""Exploratory MER: simplified Chinese characters plus lowercase English words.

NFKC, traditional-to-simplified conversion and punctuation removal are applied
equally to references/hypotheses. Numbers are NOT rewritten semantically.
Language/boundary S+D are diagnostics on one global minimum-edit alignment,
not separately computed CER/WER. MER includes all insertions.
"""

import re
import unicodedata

from opencc import OpenCC


CONVERTER = OpenCC("t2s")
TOKEN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]|[a-z]+(?:'[a-z]+)*|[0-9]+|[^\W_]", re.UNICODE)


def tokens(text):
    return TOKEN.findall(CONVERTER.convert(unicodedata.normalize("NFKC", text).lower()))


def language(token):
    if re.fullmatch(r"[\u3400-\u4dbf\u4e00-\u9fff]", token):
        return "zh"
    return "en" if re.fullmatch(r"[a-z]+(?:'[a-z]+)*", token) else "other"


def score(reference, hypothesis):
    ref, hyp = tokens(reference), tokens(hypothesis)
    dp = [[0] * (len(hyp) + 1) for _ in range(len(ref) + 1)]
    for i in range(len(ref) + 1):
        dp[i][0] = i
    for j in range(len(hyp) + 1):
        dp[0][j] = j
    for i in range(1, len(ref) + 1):
        for j in range(1, len(hyp) + 1):
            dp[i][j] = min(dp[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]),
                           dp[i - 1][j] + 1, dp[i][j - 1] + 1)
    boundary = set()
    for i in range(1, len(ref)):
        if {language(ref[i - 1]), language(ref[i])} == {"zh", "en"}:
            boundary.update((i - 1, i))
    result = {
        "reference_tokens": len(ref), "errors": dp[-1][-1],
        "substitutions": 0, "deletions": 0, "insertions": 0,
        "boundary_tokens": len(boundary), "boundary_sd": 0,
    }
    for lang in ("zh", "en", "other"):
        result[f"{lang}_tokens"] = sum(language(t) == lang for t in ref)
        result[f"{lang}_sd"] = 0
    i, j = len(ref), len(hyp)
    while i or j:
        if i and j and dp[i][j] == dp[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            incorrect = ref[i - 1] != hyp[j - 1]
            result["substitutions"] += incorrect
            j -= 1
        elif i and dp[i][j] == dp[i - 1][j] + 1:
            incorrect = True
            result["deletions"] += 1
        else:
            result["insertions"] += 1
            j -= 1
            continue
        i -= 1
        if incorrect:
            result[f"{language(ref[i])}_sd"] += 1
            result["boundary_sd"] += i in boundary
    result["mer"] = result["errors"] / len(ref) if ref else None
    return result
