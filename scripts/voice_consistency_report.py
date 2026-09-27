"""Diagnostic equality evidence; never a replacement for frozen accuracy gates."""

import base64
import binascii
from collections import Counter
import hashlib
import itertools
import json
import math
from pathlib import Path
import re
import sys

THREADS = (2, 1, 4)
REPETITIONS = (1, 2, 3)
SURFACES = ("native", "transcriber", "api")
SAMPLE_KEYS = ("id", "dataset", "reference", "category", "duration", "split", "audio_sha256")


def band(duration):
    return "short" if duration <= 5 else "long" if duration >= 15 else "medium"


def select_samples(manifest):
    if (len(manifest) != 100 or len({r["id"] for r in manifest}) != 100
            or Counter(r["dataset"] for r in manifest) != {"ASCEND": 60, "AISHELL-4": 40}):
        raise ValueError("Expected original frozen100 identity")
    selected = [r for r in manifest if r["category"] == "mixed" and band(r["duration"]) == "medium"]
    if len(selected) != 8:
        raise ValueError("Expected exactly eight mixed/medium diagnostic samples")
    for category, duration in (("zh", "short"), ("en", "short"), ("zh", "long"), ("mixed", "long")):
        pool = [r for r in manifest if r["category"] == category and band(r["duration"]) == duration]
        if not pool:
            raise ValueError("Missing control stratum")
        selected.append(min(pool, key=lambda r: (
            hashlib.sha256(("sense-consistency-v1:" + r["id"]).encode()).hexdigest(), r["id"])))
    return sorted(selected, key=lambda r: r["id"])


def finite(value):
    return not isinstance(value, bool) and isinstance(value, (float, int)) and math.isfinite(value) and value >= 0


def key(row):
    return row["id"], row["threads"], row["repetition"], row["surface"]


def compare(rows, **labels):
    equal = None if any(r["failure"] for r in rows) else len({r["text"] for r in rows}) == 1
    return {**labels, "equal": equal,
            **({"texts": [r["text"] for r in rows]} if equal is False else {})}


def platform_report(samples, rows, identity):
    source = {r["id"]: r for r in samples}
    if len(samples) != 12 or len(source) != 12:
        raise ValueError("Expected twelve unique selected samples")
    if set(identity) != {"manifest", "binary", "model", "helper"} or any(
            not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
            for name, value in identity.items() if name != "helper" or value is not None):
        raise ValueError("Invalid package identity")
    platforms = {r["platform"] for r in rows}
    if len(platforms) != 1 or not platforms <= {"linux", "win32"}:
        raise ValueError("Expected one supported platform")
    platform = next(iter(platforms))
    if (identity["helper"] is None) != (platform == "linux"):
        raise ValueError("Helper identity differs from platform")
    expected = set(itertools.product(source, THREADS, REPETITIONS, SURFACES))
    indexed = {key(row): row for row in rows}
    if len(indexed) != len(rows) or set(indexed) != expected:
        raise ValueError("Incomplete, unexpected or duplicate attempt matrix")
    for row in rows:
        if type(row["threads"]) is not int or type(row["repetition"]) is not int:
            raise ValueError("Invalid tuple types")
        if any(row[field] != source[row["id"]][field] for field in SAMPLE_KEYS) or row["identity"] != identity:
            raise ValueError("Attempt input/package identity differs")
        if not finite(row["seconds"]):
            raise ValueError("Invalid attempt latency")
        failure = row["failure"]
        if failure is not None and (not isinstance(failure, str) or not failure):
            raise ValueError("Invalid failure")
        if failure:
            if row["text"] is not None or row["apiElapsedMs"] is not None:
                raise ValueError("Failure cannot claim successful text/timing")
        elif not isinstance(row["text"], str) or not row["text"].strip() or "\0" in row["text"]:
            raise ValueError("Empty or invalid success")
        if row["apiElapsedMs"] is not None and not finite(row["apiElapsedMs"]):
            raise ValueError("Invalid API timing")
        if row["surface"] == "api":
            if (not failure and (row["status"] != 200 or row["apiElapsedMs"] is None)
                    or failure and row["status"] not in (None, 200, 422, 500, 502, 503, 504)):
                raise ValueError("Invalid API outcome")
        elif row["status"] is not None or row["apiElapsedMs"] is not None:
            raise ValueError("Non-API attempt has HTTP metadata")
        if row["surface"] == "native" and not failure:
            try:
                raw = base64.b64decode(row["stdoutBase64"], validate=True)
                text = raw.decode("utf-8").strip()
            except (ValueError, TypeError, UnicodeError, binascii.Error) as error:
                raise ValueError("Invalid native stdout") from error
            if (len(raw) > 32768 or base64.b64encode(raw).decode() != row["stdoutBase64"]
                    or hashlib.sha256(raw).hexdigest() != row["stdoutSha256"] or text != row["text"]):
                raise ValueError("Native stdout identity/text differs")
        elif row["stdoutBase64"] is not None or row["stdoutSha256"] is not None:
            raise ValueError("Unexpected native success bytes")
    repeatability, layers, threads = [], [], []
    for sample in sorted(source):
        for thread in THREADS:
            for surface in SURFACES:
                repeatability.append(compare(
                    [indexed[sample, thread, rep, surface] for rep in REPETITIONS],
                    id=sample, threads=thread, surface=surface))
            for rep in REPETITIONS:
                for left, right in itertools.combinations(SURFACES, 2):
                    layers.append(compare(
                        [indexed[sample, thread, rep, left], indexed[sample, thread, rep, right]],
                        id=sample, threads=thread, repetition=rep, surfaces=[left, right]))
        for surface in SURFACES:
            for rep in REPETITIONS:
                for left, right in itertools.combinations(THREADS, 2):
                    threads.append(compare(
                        [indexed[sample, left, rep, surface], indexed[sample, right, rep, surface]],
                        id=sample, surface=surface, repetition=rep, threads=[left, right]))
    return {"platform": platform, "attempts": len(rows),
            "delivered": sum(not r["failure"] for r in rows),
            "failures": [{"key": key(r), "failure": r["failure"]} for r in rows if r["failure"]],
            "repeatability": repeatability, "layers": layers, "threads": threads}


def read_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def read_rows(file):
    return [json.loads(line) for line in Path(file).read_text(encoding="utf-8").splitlines()]


def historical_comparisons(samples, rows, identity, prior):
    prior = Path(prior) / "installed-evidence"
    host = read_json(prior / "environment.json")
    manifest = (prior / "package-manifest.json").read_bytes()
    if (host["manifestSha256"] != identity["manifest"]
            or hashlib.sha256(manifest).hexdigest() != identity["manifest"]
            or read_json(prior / "complete.json") != {"count": 100, "variant": "sensevoice-small-q8"}):
        raise ValueError("Historical package/completion differs")
    old_rows = read_rows(prior / "results.jsonl")
    old = {r["id"]: r for r in old_rows}
    if len(old_rows) != 100 or len(old) != 100:
        raise ValueError("Historical corpus incomplete")
    for sample in samples:
        if sample["id"] not in old or any(old[sample["id"]][k] != sample[k] for k in SAMPLE_KEYS):
            raise ValueError("Historical sample identity differs")
    paired = []
    for row in rows:
        if row["threads"] == 2 and row["surface"] == "api":
            paired.append(compare([row, old[row["id"]]], id=row["id"], repetition=row["repetition"]))
    return {"environment": host, "comparisons": paired}


def aggregate(left, right, left_prior, right_prior, destination):
    reports, indexed, hosts, historical = {}, {}, {}, {}
    selected = None
    for folder, prior, expected_platform in ((left, left_prior, "linux"), (right, right_prior, "win32")):
        root = Path(folder)
        samples = read_json(root / "samples.json")
        if selected is not None and selected != samples:
            raise ValueError("Cross-platform selected samples differ")
        selected = samples
        host = read_json(root / "environment.json")
        if host["platform"] != expected_platform:
            raise ValueError("Unexpected platform evidence")
        manifest_bytes = (root / "package-manifest.json").read_bytes()
        if hashlib.sha256(manifest_bytes).hexdigest() != host["identity"]["manifest"]:
            raise ValueError("Retained manifest digest differs")
        manifest = json.loads(manifest_bytes)
        for role in ("binary", "model", "helper"):
            entries = [file for file in manifest["files"] if file["role"] == role]
            if ([file["sha256"] for file in entries] if entries else [None]) != [host["identity"][role]]:
                raise ValueError("Retained package role differs")
        rows = []
        for thread in THREADS:
            if read_json(root / f"complete-{thread}.json") != {"threads": thread, "count": 108}:
                raise ValueError("Missing thread completion")
            rows += read_rows(root / f"attempts-{thread}.jsonl")
        reports[expected_platform] = platform_report(samples, rows, host["identity"])
        hosts[expected_platform] = host
        historical[expected_platform] = historical_comparisons(samples, rows, host["identity"], prior)
        indexed[expected_platform] = {key(row): row for row in rows}
    if hosts["linux"]["identity"]["model"] != hosts["win32"]["identity"]["model"]:
        raise ValueError("Compared weights differ")
    cross = [compare([row, indexed["win32"][tuple_key]], key=tuple_key)
             for tuple_key, row in sorted(indexed["linux"].items())]
    result = {"scope": "Diagnostic subset, not qualification or causal proof.",
              "platforms": reports, "environments": hosts, "historical": historical, "cross_platform": cross,
              "release_approved": False, "default_threads_changed": False}
    output = Path(destination)
    output.mkdir(parents=True, exist_ok=True)
    (output / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# Installed Sense consistency diagnostics", "", result["scope"], "",
             "| Comparison | Equal | Different | Unavailable |",
             "| --- | ---: | ---: | ---: |"]
    comparisons = [("Cross-platform", cross)]
    for platform, report in reports.items():
        lines.append(f"| {platform} delivery | {report['delivered']}/324 | - | - |")
        comparisons += [(f"{platform} {name}", report[name]) for name in ("repeatability", "layers", "threads")]
        comparisons.append((f"{platform} historical API", historical[platform]["comparisons"]))
    for name, values in comparisons:
        counts = Counter(row["equal"] for row in values)
        lines.append(f"| {name} | {counts[True]} | {counts[False]} | {counts[None]} |")
    lines += ["", "Exact text equality; raw bytes retained separately. Failures are never equal nulls.",
              "Layers use separate invocations and share supervision/decoding. Inspect repeatability before attribution.",
              "Compiler, OS and CPU effects are not isolated. No test-set tuning or quality/latency approval.",
              "No browser capture, Win11, physical microphone or release claim."]
    (output / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return int(any(r["delivered"] != 324 for r in reports.values()))


def main():
    action, *args = sys.argv[1:]
    if action == "select" and len(args) == 2:
        corpus, output = map(Path, args)
        rows = select_samples(read_json(corpus / "samples.json"))
        output.mkdir(parents=True, exist_ok=True)
        (output / "samples.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0
    if action == "aggregate" and len(args) == 5:
        return aggregate(*args)
    raise ValueError("Expected select CORPUS OUTPUT or aggregate LINUX WINDOWS PRIOR_LINUX PRIOR_WINDOWS OUTPUT")


if __name__ == "__main__":
    sys.exit(main())
