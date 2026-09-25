"""Actions-only analysis of four pinned artifacts; no inference or new capture."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import zipfile

from voice_browser_cases import CASES
from voice_browser_evidence import BASELINE_ARCHIVES, load_platform
from voice_consistency_report import read_json, read_rows
from voice_webkit_analysis import CASE, PATHS, analyze

REPO = "xujxu/agents-chat"
SOURCE_RUN = "36085430283"
SOURCE_COMMIT = "7b680acb264b466868cff05a6f8dd9b40d856dcc"
INPUTS = {
    "webkit": ("10844047138", SOURCE_RUN, "installed-browser-linux-webkit-mobile",
               "0d2db5c932f787681047f425f984156c3c327e1428078eef0b1c42cf5fa6b9ff"),
    "baseline": ("10844915649", SOURCE_RUN, "installed-matrix-baseline",
                 "88cef00dabb62b5f4de6b1dcec7352ec66a6a0a7047d52e824de4cbb72914e3d"),
    "matrix": ("10845090269", SOURCE_RUN, "installed-matrix-report",
               "5dc240fda7861a20ce471c7746bf9cf22337cbc220222af0c83070b6b945acea"),
    "original": ("10751002303", "35858271102", None, None),
}


def file_hash(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_metadata(metadata, key):
    artifact_id, run, name, digest = INPUTS[key]
    actual = metadata.get("digest", "")
    if (str(metadata.get("id")) != artifact_id or metadata.get("expired") is not False
            or str(metadata.get("workflow_run", {}).get("id")) != run
            or (name is not None and metadata.get("name") != name)
            or len(actual) != 71 or not actual.startswith("sha256:")
            or any(c not in "0123456789abcdef" for c in actual[7:])
            or (digest is not None and actual != "sha256:" + digest)):
        raise ValueError(f"Artifact metadata differs: {key}")
    if key != "original" and metadata["workflow_run"].get("head_sha") != SOURCE_COMMIT:
        raise ValueError(f"Artifact source commit differs: {key}")
    return actual[7:]


def extract_verified(archive, destination, expected):
    if file_hash(archive) != expected:
        raise ValueError("Downloaded artifact digest differs")
    with zipfile.ZipFile(archive) as zipped:
        infos = zipped.infolist()
        names = set()
        total = 0
        for info in infos:
            path = PurePosixPath(info.filename)
            total += info.file_size
            if (not info.filename or path.is_absolute() or ".." in path.parts
                    or "\\" in info.filename or ":" in info.filename
                    or info.filename in names or stat.S_ISLNK(info.external_attr >> 16)
                    or total > 512 * 1024 * 1024):
                raise ValueError("Unsafe or excessive evidence archive")
            names.add(info.filename)
        destination.mkdir(parents=True, exist_ok=False)
        zipped.extractall(destination)


def download(inputs):
    inputs.mkdir(parents=True, exist_ok=False)
    provenance = {}
    for key, (artifact_id, _, _, _) in INPUTS.items():
        endpoint = f"repos/{REPO}/actions/artifacts/{artifact_id}"
        metadata = json.loads(subprocess.check_output(["gh", "api", endpoint], timeout=60))
        expected = validate_metadata(metadata, key)
        archive = inputs / f"{key}.zip"
        with archive.open("wb") as stream:
            subprocess.run(["gh", "api", endpoint + "/zip"], stdout=stream, check=True, timeout=300)
        extract_verified(archive, inputs / key, expected)
        provenance[key] = {"repository": REPO, "id": artifact_id, "name": metadata["name"],
                           "run": str(metadata["workflow_run"]["id"]),
                           "commit": metadata["workflow_run"].get("head_sha"),
                           "archive_sha256": expected, "expires_at": metadata["expires_at"]}
        archive.unlink()
    return provenance


def validate_history(complete, environment, matrix, host):
    if complete != {"count": 200, "run": SOURCE_RUN, "commit": SOURCE_COMMIT, "cases": list(CASES)}:
        raise ValueError("Historical baseline completion differs")
    if (matrix.get("status") != "complete" or matrix.get("attempts") != 400
            or matrix.get("cases") != list(CASES) or matrix.get("release_approved") is not False
            or matrix.get("environments", {}).get(CASE) != host
            or matrix.get("baseline_environment") != environment):
        raise ValueError("Historical matrix identity differs")
    if (environment.get("run") != SOURCE_RUN or environment.get("commit") != SOURCE_COMMIT
            or environment.get("archives") != BASELINE_ARCHIVES or environment.get("cases") != list(CASES)
            or environment.get("threads") != 2 or environment.get("timeout") != 120):
        raise ValueError("Historical baseline provenance differs")
    arguments = environment.get("arguments", [])
    if (len(arguments) != 7 or arguments[:3] != ["--num-threads=2", "--provider=cpu", "--debug=0"]
            or not arguments[3].startswith("--tokens=/") or not arguments[3].endswith("/tokens.txt")
            or not arguments[4].startswith("--sense-voice-model=/")
            or not arguments[4].endswith("/model.int8.onnx")
            or arguments[5:] != ["--sense-voice-language=auto", "--sense-voice-use-itn=1"]):
        raise ValueError("Historical baseline arguments differ")


def write_report(output, result):
    output.mkdir(parents=True, exist_ok=True)
    for name in ("summary", "samples"):
        (output / f"{name}.json").write_text(json.dumps(result[name], ensure_ascii=False, indent=2) + "\n",
                                           encoding="utf-8")
    summary = result["summary"]
    lines = ["# Existing WebKit mixed/medium error analysis", "",
             "All eight original-duration samples; no recording, inference or acceptance rerun.", "",
             f"Reference units: {summary['reference_units']}; original ceiling: {summary['quality_ceiling']:.6%}.",
             "Recomputed scores agree with retained measurement evidence.", "",
             "| Path | Errors | S | D | I | MER |",
             "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for name in PATHS:
        total = summary["totals"][name]
        lines.append(f"| {name} | {total['errors']} | {total['substitutions']} | {total['deletions']} | "
                     f"{total['insertions']} | {total['error_rate']:.6%} |")
    lines += ["", "| Sample | Original ONNX | Original native | Captured ONNX | Captured native | Primary delta errors | Contribution pp |",
              "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for sample in result["samples"]:
        counts = " | ".join(str(sample["paths"][name]["score"]["errors"]) for name in PATHS)
        change = sample["contrasts"]["primary"]
        lines.append(f"| {sample['id']} | {counts} | {change['errors']:+d} | {change['percentage_points']:+.6f} |")
    lines += ["", "| Contrast (first minus second) | Delta errors | Percentage points |",
              "| --- | ---: | ---: |"]
    for name, value in summary["contrasts"].items():
        lines.append(f"| {name} | {value['errors']:+d} | {value['percentage_points']:+.6f} |")
    lines += ["", "Primary: captured native minus original ONNX; native_input: captured minus original native;",
              "onnx_input: captured minus original ONNX; captured_backend: native minus ONNX on the same upload.",
              "", "## Interpretation limits", "",
              "These are retained input/backend outcome contrasts, not causal browser, acoustic or numerical attribution.",
              "No clipping, lost speech, resampling defect or reference error is established by changed transcripts.",
              "Historical original ONNX is not a simultaneous same-host trial. The inspected corpus is not an untouched holdout.",
              "The failed original-stimulus acceptance result and all thresholds remain unchanged.",
              "See samples.json for references, raw/normalized hypotheses, counts, signed contributions and capture context.",
              "ASCEND attribution is retained alongside this report."]
    (output / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines), flush=True)


def run(inputs, output):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Evidence computation requires Actions")
    inputs, output = Path(inputs), Path(output)
    artifacts = download(inputs)
    samples, attempts, host = load_platform(inputs / "webkit", "linux", SOURCE_RUN, SOURCE_COMMIT, CASE)
    matrix = read_json(inputs / "matrix/summary.json")
    environment = read_json(inputs / "baseline/environment.json")
    validate_history(read_json(inputs / "baseline/complete.json"), environment, matrix, host)
    originals = [r for r in read_rows(inputs / "original/scored-results.jsonl") if r["variant"] == "sense"]
    result = analyze(samples, attempts, originals, read_rows(inputs / "baseline/results.jsonl"), matrix)
    result["summary"].update(
        status="complete", source={"run": SOURCE_RUN, "commit": SOURCE_COMMIT},
        analysis={"run": os.environ["GITHUB_RUN_ID"], "commit": os.environ["GITHUB_SHA"]},
        artifacts=artifacts,
        files={str(p.relative_to(inputs)): file_hash(p) for p in (
            inputs / "webkit/results.jsonl", inputs / "webkit/samples.json",
            inputs / "baseline/results.jsonl", inputs / "matrix/summary.json",
            inputs / "original/scored-results.jsonl")},
    )
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(inputs / "webkit/ASCEND-ATTRIBUTION.txt", output / "ASCEND-ATTRIBUTION.txt")
    write_report(output, result)


def main(args):
    if len(args) != 2:
        raise ValueError("Expected input and output directories")
    try:
        run(*args)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        output = Path(args[1])
        output.mkdir(parents=True, exist_ok=True)
        failure = {"status": "incomplete", "release_approved": False, "error": str(error),
                   "analysis": {"run": os.environ.get("GITHUB_RUN_ID"), "commit": os.environ.get("GITHUB_SHA")}}
        (output / "failure.json").write_text(json.dumps(failure, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(failure), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
