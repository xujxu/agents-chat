"""Same-host repeatability diagnostics, never a replacement for full-set scores."""

import json
from pathlib import Path
import sys

from voice_corpus_report import evaluate
from voice_server_profiles import PROFILES, select_english


def compare_repetitions(samples, rows):
    source = {row["id"]: row for row in samples}
    if not source or len(source) != len(samples) or any(row["category"] != "en" for row in samples):
        raise ValueError("Expected distinct English source samples")
    expected = {(identifier, profile, repeat) for identifier in source
                for profile in PROFILES for repeat in range(3)}
    observed = {}
    for row in rows:
        key = row["id"], row["profile"], row["repeat"]
        if key not in expected or key in observed or row["variant"] != "qwen-int8":
            raise ValueError("Unexpected or duplicate observation")
        if any(row[name] != source[row["id"]][name]
               for name in ("audio_sha256", "reference", "category", "duration")):
            raise ValueError("Repeated input identity differs")
        if not row["failure"] and not row["text"]:
            raise ValueError("Empty output must be recorded as a failure")
        observed[key] = row
    if observed.keys() != expected:
        raise ValueError("Incomplete repeated evidence")

    def output(identifier, profile, repeat):
        row = observed[identifier, profile, repeat]
        return row["failure"], row["text"]

    within = {profile: sorted(identifier for identifier in source
                             if len({output(identifier, profile, r) for r in range(3)}) > 1)
              for profile in PROFILES}
    cross = sorted(identifier for identifier in source
                   if any(output(identifier, "cpu2-ram4", repeat) != output(identifier, "cpu4-ram8", repeat)
                          for repeat in range(3)))
    scores = []
    for profile in PROFILES:
        for repeat in range(3):
            group = [evaluate(observed[identifier, profile, repeat]) for identifier in source]
            scores.append({"profile": profile, "repeat": repeat,
                           "wer": sum(row["delivered_score"]["errors"] for row in group) /
                                  sum(row["delivered_score"]["reference_tokens"] for row in group),
                           "failures": sum(bool(row["failure"]) for row in group)})
    failures = sum(bool(row["failure"]) for row in rows)
    return {"attempts": len(rows), "samples": len(samples), "failures": failures,
            "within_profile_changes": within, "cross_profile_changes": cross, "scores": scores,
            "stable_on_this_host": not failures and not cross and not any(within.values()),
            "scope": "Exact returned text and failures, no favorable-repeat selection. "
                     "Same-host result does not establish cross-ISA stability or isolate a cause."}


def report(root):
    root = Path(root)
    samples = select_english(json.loads((root / "corpus/samples.json").read_text()))
    selected = {row["id"] for row in samples}
    rows = []
    for profile in PROFILES:
        for repeat in range(3):
            case = f"{profile}/case-qwen-int8" if repeat == 0 else f"{profile}/repeat-{repeat}/case-qwen-int8"
            folder = root / case / "artifacts"
            completion = json.loads((folder / "complete.json").read_text())
            if completion != {"count": 100 if repeat == 0 else 6, "variant": "qwen-int8", "profile": profile}:
                raise ValueError("Incomplete repeat execution")
            for line in (folder / "results.jsonl").read_text().splitlines():
                row = json.loads(line)
                if repeat != 0 or row["id"] in selected:
                    rows.append({**row, "repeat": repeat})
    result = compare_repetitions(samples, rows)
    output = root / "stability"
    output.mkdir(exist_ok=False)
    (output / "summary.json").write_text(json.dumps(result, indent=2))
    (output / "observations.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    report(sys.argv[1])
