"""CI-only CPU budget screening; never an automatic installation approval."""

from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import sys

from voice_accuracy_benchmark import trial
from voice_corpus_report import evaluate
from voice_choice import band, decide


PROFILES = {"cpu2-ram4": {"threads": 2, "memory_gib": 4},
            "cpu4-ram8": {"threads": 4, "memory_gib": 8}}
VARIANTS = {"whisper-small": "whisper", "whisper-turbo": "whisper",
            "funasr-u8u8": "funasr", "qwen-int8": "qwen"}
SENSE_VARIANTS = {"sense-gguf-q8": "sense-gguf"}
NANO_QWEN_VARIANTS = {name: VARIANTS[name] for name in ("funasr-u8u8", "qwen-int8")}
CANDIDATE_SETS = {"main": VARIANTS, "sense": SENSE_VARIANTS, "nano-qwen": NANO_QWEN_VARIANTS}


def select_probes(rows):
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate source identity")
    selected = []
    for category, long, count in (("zh", False, 6), ("en", False, 6), ("mixed", False, 6),
                                  ("zh", True, 3), ("mixed", True, 3)):
        pool = [row for row in rows if row["category"] == category and
                (15 <= row["duration"] <= 30 if long else 0 < row["duration"] <= 5)]
        ranked = sorted(pool, key=lambda row: hashlib.sha256(
            f"server-profile-v1:{row['id']}".encode()).hexdigest())
        if len(ranked) < count:
            raise ValueError("Incomplete profile stratum")
        selected.extend(ranked[:count])
    return selected


def p95(values):
    return sorted(values)[math.ceil(.95 * len(values)) - 1] if values else None


def select_english(rows):
    return [row for row in select_probes(rows) if row["category"] == "en"]


def summarize_profile(manifest, rows):
    expected = {row["id"]: row for row in manifest}
    if not expected or len(expected) != len(manifest):
        raise ValueError("Invalid source manifest")
    if len(rows) != len(expected) or {row["id"] for row in rows} != expected.keys():
        raise ValueError("Incomplete or duplicate profile evidence")
    groups = defaultdict(list)
    failures = Counter()
    peaks = []
    for row in rows:
        if any(row[key] != expected[row["id"]][key]
               for key in ("reference", "category", "duration", "audio_sha256")):
            raise ValueError("Compared input differs")
        if row["failure"] or not row["text"]:
            failures[row["failure"] or "empty_transcript"] += 1
        if row["peak_rss_kib"] is not None:
            peaks.append(row["peak_rss_kib"])
        scored = evaluate(row)
        groups[row["category"], band(row["duration"])].append(scored)
    metrics = []
    for (category, duration_band), items in sorted(groups.items()):
        successful = [row["seconds"] for row in items if not row["failure"] and row["text"]]
        metrics.append({
            "category": category, "duration_band": duration_band, "samples": len(items),
            "delivered": len(successful),
            "error_rate": sum(row["delivered_score"]["errors"] for row in items) /
                          sum(row["delivered_score"]["reference_tokens"] for row in items),
            "successful_p95_seconds": p95(successful),
            "attempt_p95_seconds": p95([row["seconds"] for row in items]),
        })
    return {"samples": len(rows), "delivered": len(rows) - sum(failures.values()),
            "all_delivered": not failures, "failures": dict(failures),
            "peak_process_rss_mib": max(peaks) / 1024 if peaks else None,
            "missing_peak_measurements": len(rows) - len(peaks), "groups": metrics,
            "install_approved": False,
            "scope": "Small CPU resource screen; cold process includes loading, no HTTP/browser overhead. "
                     "Not minimum hardware, resident-worker latency, license approval or quality acceptance."}


def cgroup_snapshot():
    root = Path("/sys/fs/cgroup")
    return {
        "memory_peak_bytes": int((root / "memory.peak").read_text()),
        "memory_max_bytes": int((root / "memory.max").read_text()),
        "cpu_max": (root / "cpu.max").read_text().strip(),
        "events": {key: int(value) for key, value in
                   (line.split() for line in (root / "memory.events").read_text().splitlines())},
    }


def run(variant, profile, sample_set="probes"):
    budget = PROFILES[profile]
    model = {**VARIANTS, **SENSE_VARIANTS}[variant]
    source = json.loads(Path("../corpus/samples.json").read_text())
    manifest = {"probes": select_probes, "fixed100": list, "english6": select_english}[sample_set](source)
    if sample_set == "fixed100" and (len(manifest) != 100 or len({row["id"] for row in manifest}) != 100):
        raise ValueError("Incomplete frozen full corpus")
    output = Path("artifacts")
    output.mkdir(exist_ok=False)
    before = cgroup_snapshot()
    quota, period = before["cpu_max"].split()
    if int(quota) / int(period) != budget["threads"] or before["memory_max_bytes"] != budget["memory_gib"] * 1024**3:
        raise ValueError("Container quota does not match declared voice budget")
    (output / "environment.json").write_text(json.dumps({
        "variant": variant, "profile": profile, **budget,
        "sha": os.environ.get("GITHUB_SHA"), "run": os.environ.get("GITHUB_RUN_ID"),
        "cpu": Path("/proc/cpuinfo").read_text().split("\n\n")[0],
        "cpu_affinity": sorted(os.sched_getaffinity(0)),
        "platform": platform.platform(), "cgroup_before": before,
        "request_timeout_seconds": 120, "one_fresh_process_per_sample": True,
        "production_transcriber": False, "sample_set": sample_set,
        "medium_duration_probes": sum(5 < row["duration"] < 15 for row in manifest),
    }, indent=2))
    (output / "samples.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    rows = []
    with (output / "results.jsonl").open("w") as stream:
        for sample in manifest:
            audio = Path("accuracy-samples") / f"{sample['id']}.wav"
            with audio.open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() != sample["audio_sha256"]:
                    raise ValueError("Audio checksum differs")
            start = cgroup_snapshot()
            row = trial(model, sample, score_reference=False, **budget)
            after = cgroup_snapshot()
            if after["events"]["oom_kill"] > start["events"]["oom_kill"]:
                row["failure"] = "cgroup_oom_kill"
            if not row["failure"] and not row["text"]:
                row["failure"] = "empty_transcript"
            row.update(variant=variant, profile=profile, cgroup_after=after)
            rows.append(row)
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
            stream.flush()
            print(f"{variant}/{profile} {len(rows)}/{len(manifest)} "
                  f"{row['seconds']:.2f}s failure={row['failure']}", flush=True)
    summary = summarize_profile(manifest, rows)
    summary["cgroup_peak_mib"] = cgroup_snapshot()["memory_peak_bytes"] / 1024**2
    summary["memory_note"] = "Container peak includes runner and charged file cache, not just native RSS."
    (output / "summary.json").write_text(json.dumps(summary, indent=2))
    (output / "complete.json").write_text(json.dumps({"count": len(rows), "variant": variant, "profile": profile}))


def report(profile, destination, candidate_set="main", sample_set="probes"):
    profiles = {}
    identity = None
    for variant in CANDIDATE_SETS[candidate_set]:
        root = Path(f"case-{variant}/artifacts")
        complete = json.loads((root / "complete.json").read_text())
        expected_count = {"probes": 24, "fixed100": 100}[sample_set]
        if complete != {"count": expected_count, "variant": variant, "profile": profile}:
            raise ValueError("Incomplete candidate")
        manifest = json.loads((root / "samples.json").read_text())
        if identity is not None and identity != manifest:
            raise ValueError("Candidates saw different samples")
        identity = manifest
        rows = [json.loads(line) for line in (root / "results.jsonl").read_text().splitlines()]
        summary = summarize_profile(manifest, rows)
        stored = json.loads((root / "summary.json").read_text())
        profiles[variant] = {**summary, "cgroup_peak_mib": stored["cgroup_peak_mib"]}
    output = Path(destination)
    output.mkdir(exist_ok=False)
    (output / "summary.json").write_text(json.dumps(profiles, indent=2))
    lines = [f"# CPU resource screen: {profile}", "",
             f"{expected_count} fixed samples; not minimum hardware or installation/quality approval.",
             "Cold native process including model load; no browser/API overhead. No resident-worker results.",
             "Failure-inclusive error; successful P95 is conditional and sample sizes are small.", "",
             "| Candidate | Delivered | Native peak MiB | Container peak MiB |",
             "|---|---:|---:|---:|"]
    for variant, summary in profiles.items():
        lines.append(f"| {variant} | {summary['delivered']}/{expected_count} | "
                     f"{summary['peak_process_rss_mib']} | {summary['cgroup_peak_mib']:.1f} |")
    lines += ["", "| Candidate | Group | N | Delivered | Error | Successful P95 s |",
              "|---|---|---:|---:|---:|---:|"]
    for variant, summary in profiles.items():
        for group in summary["groups"]:
            latency = group["successful_p95_seconds"]
            lines.append(f"| {variant} | {group['category']}/{group['duration_band']} | "
                         f"{group['samples']} | {group['delivered']} | {group['error_rate']:.2%} | "
                         f"{latency if latency is not None else 'unavailable'} |")
    for variant, summary in profiles.items():
        lines.append(f"\n{variant} failures: {summary['failures']}\n")
    (output / "REPORT.md").write_text("\n".join(lines))


def gates(profile_directory, candidate_set="sense"):
    directory = Path(profile_directory)
    variants = CANDIDATE_SETS[candidate_set]
    manifest, rows = None, []
    for variant in variants:
        source = directory / f"case-{variant}/artifacts"
        current = json.loads((source / "samples.json").read_text())
        complete = json.loads((source / "complete.json").read_text())
        if complete != {"count": 100, "variant": variant, "profile": directory.name}:
            raise ValueError("Incomplete full-set candidate evidence")
        if manifest is not None and current != manifest:
            raise ValueError("Candidate inputs differ")
        manifest = current
        candidate_rows = [json.loads(line) for line in (source / "results.jsonl").read_text().splitlines()]
        if any(row["variant"] != variant or row["profile"] != directory.name for row in candidate_rows):
            raise ValueError("Candidate/profile identity differs")
        summarize_profile(manifest, candidate_rows)
        rows.extend(candidate_rows)
    prior = [json.loads(line) for line in Path("baseline/scored-results.jsonl").read_text().splitlines()]
    prior += json.loads(Path("long-baseline/long-report/scored-results.json").read_text())
    sense = {row["id"]: row for row in prior if row["variant"] == "sense"}
    baseline = []
    for sample in manifest:
        original = sense[sample["id"]]
        if original["failure"] or any(sample[key] != original[key] for key in ("audio_sha256", "reference")):
            raise ValueError("Baseline identity differs")
        baseline.append({**sample, "score": original["delivered_score"]})
    if len(manifest) != 100:
        raise ValueError("Quality gates require the frozen100, not the resource probes")
    result = decide([{**row, "score": evaluate(row)["delivered_score"]} for row in rows], baseline)
    result["scope"] = ("Engine-only under declared Docker CPU/RAM limits. NOT actual transcribeVoice "
                       "or browser/API acceptance. Original +2pp/3s/5s/100% gates unchanged.")
    (directory / "report/quality-gates.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    {"run": run, "report": report, "gates": gates}[sys.argv[1]](*sys.argv[2:])
