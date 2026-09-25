"""Strict bounded readers for newly collected synthetic graph evidence."""

import hashlib
import io
import json
import os
import wave
from pathlib import Path

import numpy as np

from voice_graph_metrics import finite

PROJECTS = ["desktop-chromium", "iphone-webkit"]
STIMULI = ["mono-tones", "mono-markers", "stereo-tones"]


def expected_ids():
    return [f"{project}/{stimulus}/{repeat}/{mode}"
            for project in PROJECTS for stimulus in STIMULI
            for repeat in range(3) for mode in (["minimal", "full"] if repeat != 1 else ["full", "minimal"])]


def unique_attempts(rows):
    result = {}
    for row in rows:
        if row["id"] in result:
            raise ValueError("Duplicate attempt")
        result[row["id"]] = row
    if set(result) != set(expected_ids()):
        raise ValueError("Missing or unknown attempts")
    return result


def read_bytes(root, item):
    path = Path(item["file"])
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("Unsafe evidence path")
    candidate = root / path
    resolved = candidate.resolve()
    if (not resolved.is_relative_to(root.resolve())
            or any(part.is_symlink() for part in [candidate, *candidate.parents])):
        raise ValueError("Unsafe evidence location")
    if not resolved.is_file() or resolved.stat().st_size > 24 * 1024 * 1024:
        raise ValueError("Missing or oversized evidence")
    data = resolved.read_bytes()
    if hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise ValueError("Evidence hash mismatch")
    return data


def read_array(root, item):
    data = read_bytes(root, item)
    if not isinstance(item["samples"], int) or len(data) != item["samples"] * 4:
        raise ValueError("Float32 shape mismatch")
    return finite(np.frombuffer(data, dtype="<f4"))


def read_wav(root, item):
    data = read_bytes(root, item)
    if (len(data) < 46 or data[:4] != b"RIFF" or data[8:16] != b"WAVEfmt "
            or int.from_bytes(data[4:8], "little") != len(data) - 8
            or data[36:40] != b"data" or int.from_bytes(data[40:44], "little") != len(data) - 44
            or int.from_bytes(data[16:20], "little") != 16
            or int.from_bytes(data[20:22], "little") != 1):
        raise ValueError("Noncanonical WAV")
    with wave.open(io.BytesIO(data)) as wav:
        channels, rate, width = wav.getnchannels(), wav.getframerate(), wav.getsampwidth()
        if channels not in (1, 2) or rate != 16000 or width != 2:
            raise ValueError("Invalid WAV format")
        if (int.from_bytes(data[28:32], "little") != rate * channels * width
                or int.from_bytes(data[32:34], "little") != channels * width):
            raise ValueError("Invalid WAV rate/alignment")
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").reshape(-1, channels)
    if len(data) != 44 + pcm.size * 2 or not 1 <= len(pcm) <= 30 * rate:
        raise ValueError("Invalid WAV count")
    return rate, [finite(pcm[:, channel] / 32768) for channel in range(channels)], pcm


def load_attempt(root, row):
    if row.get("error") or row.get("run") != str(os.environ["GITHUB_RUN_ID"]):
        raise ValueError("Attempt failed or stale run")
    if row.get("commit") != os.environ["GITHUB_SHA"]:
        raise ValueError("Stale commit")
    project, stimulus, repeat, mode = row["id"].split("/")
    if [row.get(k) for k in ("project", "stimulus", "repeat", "mode")] != [project, stimulus, int(repeat), mode]:
        raise ValueError("Attempt identity mismatch")
    snapshot = row["snapshot"]
    if (snapshot["observerError"] or snapshot["fetchFailure"] or snapshot["status"] != 200
            or snapshot["composerText"] != "Synthetic graph fixture; no ASR"
            or not all(snapshot["capture"][key] for key in
                       ("sourceCompleted", "tracksStopped", "contextClosed"))):
        raise ValueError("Incomplete capture evidence")
    timing = snapshot["timing"]
    ordered = [timing[key] for key in ("stopAt", "workletStopAt", "fetchAt", "composerAt")]
    if (timing["stopKind"] != "manual" or any(not isinstance(value, (int, float)) for value in ordered)
            or ordered != sorted(ordered) or not isinstance(timing["bodyAt"], (int, float))
            or timing["bodyAt"] < timing["fetchAt"]
            or row["receiver"] != {"requests": 1, "error": None}):
        raise ValueError("Invalid capture event order or receiver status")
    if row["F"]["sha256"] != row["received"]["sha256"]:
        raise ValueError("Receiver mismatch")
    read_bytes(root, row["received"])
    a_rate, a, _ = read_wav(root, row["A"])
    f_rate, f, pcm = read_wav(root, row["F"])
    if len(a) != (2 if stimulus == "stereo-tones" else 1) or len(a[0]) != 128000 or len(f) != 1:
        raise ValueError("Unexpected WAV channels/duration")
    stages = {"A": (a_rate, a), "F": (f_rate, f)}
    if mode == "full":
        probe = row["probe"]
        if probe["errors"] or probe["terminals"] != ["finished"] or not probe["recorderClosed"]:
            raise ValueError("Incomplete passive observation")
        events = probe["events"]
        kinds = [event["kind"] for event in events]
        if (not probe["tracks"] or not events
                or [event["at"] for event in events] != sorted(event["at"] for event in events)
                or any(kinds.count(name) != 1 for name in ("worklet_created", "B_start", "finished", "D_start", "E_rendered"))
                or not (kinds.index("worklet_created") < kinds.index("B_start") < kinds.index("finished")
                        < kinds.index("D_start") < kinds.index("E_rendered"))
                or kinds.count("chunk") != len(probe["chunkLengths"])):
            raise ValueError("Invalid passive event sequence")
        for name in "BCDE":
            stage = row[name]
            rate = stage["rate"]
            if not isinstance(rate, int) or not 1000 <= rate <= 192000:
                raise ValueError("Invalid stage rate")
            arrays = [read_array(root, item) for item in stage["channels"]]
            if len(arrays) != (len(a) if name == "B" else 1) or len({len(v) for v in arrays}) != 1:
                raise ValueError("Invalid stage channels")
            stages[name] = (rate, arrays)
        if (stages["B"][0] != snapshot["capture"]["sourceRate"]
                or stages["C"][0] != snapshot["capture"]["recorderRate"]
                or stages["D"][0] != stages["C"][0] or stages["E"][0] != 16000
                or sum(probe["chunkLengths"]) != len(stages["C"][1][0])
                or any(not 1 <= n <= 2048 for n in probe["chunkLengths"])):
            raise ValueError("Stage metadata mismatch")
    elif any(name in row for name in "BCDE") or row.get("probe") is not None:
        raise ValueError("Unexpected minimal-arm intermediate observation")
    return stages, pcm[:, 0]


def rows_from(root):
    return [json.loads(path.read_text()) for path in sorted(root.glob("*/*/*/*/attempt.json"))]
