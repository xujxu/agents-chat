"""Validate retained browser provenance before interpreting any measurements."""

import json
import os
from pathlib import Path
import re
import struct
import sys

from voice_browser_report import IDENTITY, PLATFORMS, browser_report
from voice_consistency_report import read_json, read_rows
from voice_feature_data import read_bounded, sha
from voice_browser_cases import CASES, validate_browser, validate_implementation

PACKAGE_HASHES = {
    "linux": "ccf50b7ddaef5f9a0cddd58f87c4f08421902c630b2ca2a485bfebaae727f40c",
    "win32": "ed605fe13aacaf21d0aceb18127d6bccb0a1099f561aa0ecef95952975cae905",
}
BASELINE_ARCHIVES = {
    "runtime": "d0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc",
    "model": "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
}


def captured_duration(raw):
    if not 46 <= len(raw) <= 960044 or len(raw) % 2:
        raise ValueError("Invalid captured WAV length")
    n = (len(raw) - 44) // 2
    header = struct.unpack("<4sI4s4sIHHIIHH4sI", raw[:44])
    if header != (b"RIFF", len(raw)-8, b"WAVE", b"fmt ", 16, 1, 1, 16000, 32000, 2, 16, b"data", n*2):
        raise ValueError("Noncanonical captured WAV")
    if max(abs(v) for v in struct.unpack(f"<{n}h", raw[44:])) <= 16:
        raise ValueError("Captured WAV has no speech-level signal")
    return n / 16000


def load_platform(root, platform, run, commit, case_id=None):
    root = Path(root)
    case = None
    if case_id is not None:
        if case_id not in CASES or CASES[case_id]["platform"] != platform:
            raise ValueError("Case/host selection differs")
        case = CASES[case_id]
    samples = read_json(root / "samples.json")
    if (len(samples) != 100 or len({s["id"] for s in samples}) != 100
            or any(not re.fullmatch(r"[A-Za-z0-9_-]+", s["id"]) for s in samples)):
        raise ValueError("Invalid source selection")
    if read_json(root / "complete.json") != {
        "platform": platform, "sources": 100, "attempts": 200, "model": "sensevoice-small-q8",
        **({"caseId": case_id, "run": run, "commit": commit} if case else {}),
    }:
        raise ValueError("Incomplete platform collection")
    host = read_json(root / "environment.json")
    if case:
        if host.get("caseId") != case_id or host.get("selectedCase") != case:
            raise ValueError("Host case identity differs")
        if read_json(root / "status.json") != {"caseId": case_id, "status": "complete", "run": run, "commit": commit}:
            raise ValueError("Case cleanup/collection incomplete")
        if read_json(root / "source-manifest.json") != {"caseId": case_id, "samples": samples}:
            raise ValueError("Source case manifest differs")
        validate_implementation(root)
    manifest_bytes = read_bounded(root / "package-manifest.json", 1048576)
    manifest = json.loads(manifest_bytes)
    if (host["platform"] != platform or host["run"] != run or host["commit"] != commit
            or host["model"] != "sensevoice-small-q8" or host["threads"] != 2
            or sha(manifest_bytes) != PACKAGE_HASHES[platform]
            or host["manifestSha256"] != PACKAGE_HASHES[platform]
            or host["identity"]["manifest"] != PACKAGE_HASHES[platform]):
        raise ValueError("Installed package/run identity differs")
    for role in ("binary", "model", "helper"):
        entries = [e["sha256"] for e in manifest["files"] if e["role"] == role]
        if (entries or [None]) != [host["identity"][role]]:
            raise ValueError("Installed role identity differs")
    browser = read_json(root / "browser.json")
    if case:
        validate_browser(browser, case_id)
        if case["channel"] == "msedge" and browser["executable"] != read_json(root / "edge-executable.json"):
            raise ValueError("Edge executable evidence differs")
    elif browser["browserName"] != "chromium" or not browser["version"] or browser["sourceRate"] != 48000:
        raise ValueError("Browser identity differs")
    rows = read_rows(root / "results.jsonl")
    expected = {(s["id"], p) for s in samples for p in ("direct", "browser")}
    if len(rows) != 200 or {(r["id"], r["pipeline"]) for r in rows} != expected:
        raise ValueError("Incomplete or duplicate platform attempts")
    selected = {s["id"]: s for s in samples}
    files = set()
    for row in rows:
        if case and row.get("caseId") != case_id:
            raise ValueError("Attempt case identity differs")
        if row["platform"] != platform or any(row[k] != selected[row["id"]][k] for k in IDENTITY):
            raise ValueError("Attempt source/platform changed")
        if row["pipeline"] != "browser":
            continue
        path = root / "captured" / f"{row['id']}.wav"
        if row["uploadedAudioSha256"] is None:
            if path.exists() or row["uploadedDuration"] is not None:
                raise ValueError("Unexpected captured evidence")
            continue
        files.add(path.name)
        raw = read_bounded(path, 960045)
        if sha(raw) != row["uploadedAudioSha256"]:
            raise ValueError("Captured upload checksum differs")
        try:
            duration = captured_duration(raw)
        except ValueError:
            if row["failure"] is None or row["uploadedDuration"] is not None:
                raise ValueError("Invalid WAV disguised as successful capture")
        else:
            if row["uploadedDuration"] is None or abs(duration - row["uploadedDuration"]) > 1e-9:
                raise ValueError("Captured duration differs")
    if {p.name for p in (root / "captured").glob("*.wav")} != files:
        raise ValueError("Unexpected captured files")
    if case:
        uploads = [{"caseId": case_id, "id": r["id"], "uploadedAudioSha256": r["uploadedAudioSha256"]}
                   for r in rows if r["pipeline"] == "browser"]
        if read_json(root / "upload-manifest.json") != {"caseId": case_id, "uploads": uploads}:
            raise ValueError("Upload case manifest differs")
    return samples, rows, {"host": host, "browser": browser}


def aggregate(evidence, baseline, short, long, output, mode=None):
    if mode not in (None, "matrix"):
        raise ValueError("Unknown browser report mode")
    cases = CASES if mode == "matrix" else None
    evidence, baseline, output = map(Path, (evidence, baseline, output))
    samples, rows, hosts = None, [], {}
    for group in cases if cases is not None else PLATFORMS:
        platform = cases[group]["platform"] if cases is not None else group
        current, attempts, hosts[group] = load_platform(
            evidence / group, platform, os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_SHA"],
            case_id=group if cases is not None else None)
        if samples is not None and samples != current:
            raise ValueError("Cross-platform source selection differs")
        samples = current
        rows.extend(attempts)
    prior = read_rows(short) + read_json(long)
    selected = {s["id"] for s in samples}
    original = [r for r in prior if r["variant"] == "sense" and r["id"] in selected]
    if read_json(baseline / "complete.json") != {"count": 200, "run": os.environ["GITHUB_RUN_ID"],
                                                "commit": os.environ["GITHUB_SHA"],
                                                **({"cases": list(cases)} if cases is not None else {})}:
        raise ValueError("Baseline matrix incomplete")
    provenance = read_json(baseline / "environment.json")
    if (provenance["archives"] != BASELINE_ARCHIVES
            or provenance["run"] != os.environ["GITHUB_RUN_ID"] or provenance["commit"] != os.environ["GITHUB_SHA"]):
        raise ValueError("Baseline provenance differs")
    if cases is not None and provenance.get("cases") != list(cases):
        raise ValueError("Baseline case provenance differs")
    reference = read_rows(baseline / "results.jsonl")
    report = browser_report(samples, rows, original, reference, cases=cases)
    if cases is not None:
        report.update(status="complete", cases=list(cases))
    report.update(environments=hosts, baseline_environment=provenance)
    output.mkdir(parents=True, exist_ok=True)
    (output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# Installed Sense browser acceptance", "", report["comparison"], "",
             f"Attempts: {report['attempts']}; primary pass: {report['primary_pass']}.", "",
             "| Case / platform | Path | Delivery | Short P95 s | Long P95 s | Violations |",
             "| --- | --- | ---: | ---: | ---: | --- |"]
    for cell in report["cells"]:
        times = {g["band"]: g["p95_seconds"] for g in cell["duration"]}
        lines.append(f"| {cell.get('caseId', cell['platform'])} | {cell['pipeline']} | {cell['delivered']}/100 | "
                     f"{times.get('short')} | {times.get('long')} | {', '.join(cell['violations']) or 'none'} |")
    lines += ["", "| Platform | Path | Quality group | N | Error rate | Original baseline |",
              "| --- | --- | --- | ---: | ---: | ---: |"]
    for cell in report["cells"]:
        for group in cell["quality"]:
            lines.append(f"| {cell.get('caseId', cell['platform'])} | {cell['pipeline']} | {group['category']}/{group['band']} | "
                         f"{group['samples']} | {group['error_rate']:.4%} | {group['baseline_error_rate']:.4%} |")
    lines += ["", f"Same-upload diagnostic available: {report['diagnostics']['available']}/200; "
              f"input unavailable: {report['diagnostics']['unavailable']}.",
              "Browser primary latency is stop-to-composer, not HTTP-only or API processing time.",
              "Original durations define groups; unavailable stop timing is not zero.",
              "Failed deliveries count as full reference deletions; successful-only metrics cannot rescue gates.",
              "Same-byte baseline diagnostics never relax the original-stimulus primary gates.",
              "No physical microphone, AEC, actual Win11, released Safari/iOS, real Android or release approval."]
    (output / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return int(not report["primary_pass"] or report["diagnostics"]["available"] != 200)


def main(args):
    if len(args) != 6 or args[-1] != "matrix":
        return aggregate(*args)
    try:
        return aggregate(*args)
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Invalid or missing retained inputs are explicit evidence failures, not passing subsets.
        output = Path(args[4])
        output.mkdir(parents=True, exist_ok=True)
        states = {}
        for case_id, case in CASES.items():
            try:
                _, rows, _ = load_platform(Path(args[0]) / case_id, case["platform"],
                                           os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_SHA"], case_id)
                states[case_id] = {"status": "collection_complete", "attempts": len(rows)}
            except (OSError, ValueError, KeyError, TypeError) as case_error:
                states[case_id] = {"status": "incomplete", "reason": str(case_error)}
        report = {"status": "incomplete", "primary_pass": None, "release_approved": False,
                  "reason": str(error), "cases": states}
        (output / "summary.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        (output / "REPORT.md").write_text(
            "# Installed browser matrix incomplete\n\nNo aggregate qualification.\n\n"
            + json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
