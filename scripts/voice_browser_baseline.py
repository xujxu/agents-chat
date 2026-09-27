"""Frozen ONNX replay on exact browser uploads, not a replacement acceptance gate."""

import json
import os
from pathlib import Path
import platform
import re
import sys

from voice_browser_evidence import BASELINE_ARCHIVES, load_platform
from voice_feature_exchange import file_hash, write_json
from voice_feature_process import run_native
from voice_browser_cases import CASES


def parse_text(stdout):
    values = []
    decoder = json.JSONDecoder()
    for match in re.finditer(r"^\s*\{", stdout, re.M):
        try:
            value, _ = decoder.raw_decode(stdout[match.start():].lstrip())
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and isinstance(value.get("text"), str):
            values.append(value["text"])
    if len(values) != 1 or not values[0].strip() or "\0" in values[0]:
        raise ValueError("Expected one nonempty ONNX JSON text")
    return values[0].strip()


def run(evidence, runtime, model, output, mode=None):
    if mode not in (None, "matrix"):
        raise ValueError("Unknown browser baseline mode")
    cases = CASES if mode == "matrix" else None
    if os.environ.get("GITHUB_ACTIONS") != "true" or sys.platform != "linux":
        raise RuntimeError("Baseline replay requires Linux Actions")
    evidence, runtime, model, output = map(Path, (evidence, runtime, model, output))
    identity = {"run": os.environ["GITHUB_RUN_ID"], "commit": os.environ["GITHUB_SHA"]}
    case_identity = {"cases": list(cases)} if cases is not None else {}
    for name, expected in BASELINE_ARCHIVES.items():
        if file_hash(f"{name}.tar.bz2") != expected:
            raise ValueError("Frozen baseline archive differs")
    binary = runtime / "bin/sherpa-onnx-offline"
    args = ["--num-threads=2", "--provider=cpu", "--debug=0",
            f"--tokens={model.resolve() / 'tokens.txt'}",
            f"--sense-voice-model={model.resolve() / 'model.int8.onnx'}",
            "--sense-voice-language=auto", "--sense-voice-use-itn=1"]
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "environment.json", {
        **identity, **case_identity, "archives": BASELINE_ARCHIVES, "platform": platform.platform(),
        "files": {str(p): file_hash(p) for p in (binary, model / "model.int8.onnx", model / "tokens.txt")},
        "arguments": args, "libraryPath": str(runtime.resolve() / "lib"), "threads": 2, "timeout": 120,
        "scope": "Same-upload accuracy diagnostic only; no quality-gate substitution or latency approval.",
    })
    with (output / "results.jsonl").open("w", encoding="utf-8", buffering=1) as log:
        for producer in cases if cases is not None else ("linux", "win32"):
            host = cases[producer]["platform"] if cases is not None else producer
            _, rows, _ = load_platform(evidence / producer, host, **identity,
                                      case_id=producer if cases is not None else None)
            for row in sorted((r for r in rows if r["pipeline"] == "browser"), key=lambda r: r["id"]):
                result = {"platform": host, "id": row["id"],
                          **({"caseId": producer} if cases is not None else {}),
                          "uploadedAudioSha256": row["uploadedAudioSha256"],
                          "text": None, "failure": "unavailable_input", "seconds": None, "unavailable": True}
                if row["uploadedDuration"] is not None:
                    audio = (evidence / producer / "captured" / f"{row['id']}.wav").resolve()
                    if file_hash(audio) != row["uploadedAudioSha256"]:
                        raise ValueError("Baseline upload changed after validation")
                    outcome = run_native("/usr/bin/env", [
                        f"LD_LIBRARY_PATH={runtime.resolve() / 'lib'}", str(binary.resolve()), *args, str(audio)])
                    result.update(unavailable=False, failure=outcome["failure"], seconds=outcome["seconds"])
                    if outcome["failure"] is None:
                        try:
                            result["text"] = parse_text(outcome["text"])
                        except ValueError:
                            result["failure"] = "invalid_baseline_json"
                log.write(json.dumps(result, ensure_ascii=False) + "\n")
                print(f"{producer}/{row['id']} failure={result['failure']}", flush=True)
    write_json(output / "complete.json", {"count": 200, **identity, **case_identity})


if __name__ == "__main__":
    run(*sys.argv[1:])
