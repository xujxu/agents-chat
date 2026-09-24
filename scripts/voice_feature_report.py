"""Control-gated interpretation, not accuracy selection."""

import itertools
import math

SAMPLE_KEYS = ("id", "reference", "category", "duration", "split", "dataset", "audio_sha256")
CONSUMERS = ("linux", "win32")
SOURCES = ("wav", "linux", "win32")


def exchange_report(samples, rows, history):
    selected = {row["id"]: row for row in samples}
    if len(samples) != 12 or len(selected) != 12:
        raise ValueError("Expected twelve unique samples")
    def key(row):
        return row["consumer"], row["id"], row["repetition"], row["input_source"]
    index = {key(row): row for row in rows}
    expected = set(itertools.product(CONSUMERS, selected, (1, 2, 3), SOURCES))
    if len(rows) != len(index) or set(index) != expected:
        raise ValueError("Incomplete, unexpected or duplicate matrix")
    if set(history) != set(CONSUMERS) or any(set(history[c]) != set(selected) for c in CONSUMERS):
        raise ValueError("Historical coverage differs")
    for row in rows:
        if type(row["repetition"]) is not int or any(row[k] != selected[row["id"]][k] for k in SAMPLE_KEYS):
            raise ValueError("Attempt sample identity differs")
        t = row["seconds"]
        if isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0:
            raise ValueError("Invalid latency")
        if row["failure"] is not None:
            if not isinstance(row["failure"], str) or not row["failure"] or row["text"] is not None:
                raise ValueError("Invalid failed outcome")
        elif not isinstance(row["text"], str) or not row["text"].strip() or "\0" in row["text"]:
            raise ValueError("Invalid successful text")
    results = []
    for sample in samples:
        sid = sample["id"]
        controls, text, repeats = {}, {}, {}
        for consumer in CONSUMERS:
            text[consumer] = {}
            repeats[consumer] = {}
            for source in SOURCES:
                attempts = [index[consumer, sid, rep, source] for rep in (1, 2, 3)]
                values = [r["text"] for r in attempts]
                delivered = all(r["failure"] is None for r in attempts)
                repeats[consumer][source] = None if not delivered else len(set(values)) == 1
                text[consumer][source] = values[0] if repeats[consumer][source] is True else None
            prior = history[consumer][sid]
            if not isinstance(prior, str) or not prior.strip():
                raise ValueError("Historical success missing")
            current = text[consumer]
            controls[consumer] = {
                "repeatable": all(value is True for value in repeats[consumer].values()),
                "own_replay": None if current["wav"] is None or current[consumer] is None
                else current["wav"] == current[consumer],
                "historical": None if current["wav"] is None else current["wav"] == prior,
            }
        valid = all(value is True for checks in controls.values() for value in checks.values())
        producer, downstream = {}, {}
        for c in CONSUMERS:
            a, b = text[c]["linux"], text[c]["win32"]
            producer[c] = None if a is None or b is None else a != b
        for source in ("linux", "win32"):
            a, b = text["linux"][source], text["win32"][source]
            downstream[source] = None if a is None or b is None else a != b
        classification = "invalid-controls"
        if valid:
            p, d = any(producer.values()), any(downstream.values())
            classification = "mixed" if p and d else "frontend-sufficient" if p else "downstream" if d else "unchanged"
        results.append({"id": sid, "controls": controls, "repeatability": repeats, "texts": text,
                        "producer_effect": producer, "consumer_effect": downstream, "classification": classification})
    return {"attempts": len(rows), "delivered": sum(r["failure"] is None for r in rows),
            "controls_pass": all(r["classification"] != "invalid-controls" for r in results),
            "samples": results, "release_approved": False,
            "scope": "Feature boundary diagnostics only; no compiler attribution or qualification."}
