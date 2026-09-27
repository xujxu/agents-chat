"""Pinned-source feature exchange CLI for isolated GitHub Actions jobs."""

from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from voice_consistency_report import platform_report, read_json, read_rows, select_samples
from voice_feature_data import (generate, numeric_difference, read_bounded, sha, validate_bundle,
                                validate_feature, validate_pcm, validate_selection, validate_wav)
from voice_feature_process import run_native
from voice_feature_report import CONSUMERS, SOURCES, exchange_report

REVISION = "3ff9259aade4f7e4360645df28cad8f81959ee91"


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def execution():
    return {"run": os.environ["GITHUB_RUN_ID"], "commit": os.environ["GITHUB_SHA"]}


def history(root, consumer):
    root = Path(root)
    samples = read_json(root / "samples.json")
    host = read_json(root / "environment.json")
    if host["platform"] != consumer:
        raise ValueError("Historical platform differs")
    identity = host["identity"]
    raw = (root / "package-manifest.json").read_bytes()
    if sha(raw) != identity["manifest"]:
        raise ValueError("Historical package hash differs")
    for role in ("binary", "model", "helper"):
        entries = [e["sha256"] for e in json.loads(raw)["files"] if e["role"] == role]
        if (entries or [None]) != [identity[role]]:
            raise ValueError("Historical role hash differs")
    rows = []
    for threads in (2, 1, 4):
        if read_json(root / f"complete-{threads}.json") != {"threads": threads, "count": 108}:
            raise ValueError("Historical completion missing")
        rows.extend(read_rows(root / f"attempts-{threads}.jsonl"))
    platform_report(samples, rows, identity)
    texts = {}
    for sample in samples:
        attempts = [r for r in rows if r["id"] == sample["id"] and r["threads"] == 2 and r["surface"] == "native"]
        if any(r["failure"] is not None for r in attempts) or len({r["text"] for r in attempts}) != 1:
            raise ValueError("Historical native control unavailable")
        texts[sample["id"]] = attempts[0]["text"]
    return samples, identity, texts


def prepare(corpus, prior, output):
    corpus, output = Path(corpus), Path(output)
    selected = select_samples(read_json(corpus / "samples.json"))
    expected, _, _ = history(prior, "linux")
    validate_selection(selected, expected)
    output.mkdir(parents=True, exist_ok=False)
    (output / "audio").mkdir()
    for sample in selected:
        name = f"{sample['id']}.wav"
        raw = read_bounded(corpus / "audio" / name, 960044)
        validate_wav(raw)
        if sha(raw) != sample["audio_sha256"]:
            raise ValueError("Frozen waveform changed")
        (output / "audio" / name).write_bytes(raw)
    for name in ("ASCEND-ATTRIBUTION.txt", "AISHELL-4-ATTRIBUTION.txt"):
        shutil.copyfile(corpus / name, output / name)
    write_json(output / "samples.json", selected)


def generate_extractor(source, archive, output):
    source, output = Path(source), Path(output)
    common = source / "runtime/llama.cpp/funasr-common"
    metadata = generate(source / "runtime/llama.cpp/sensevoice/funasr-sensevoice/funasr-sensevoice.cpp", output)
    metadata.update(revision=REVISION, archiveSha256=file_hash(archive),
                    headers={name: file_hash(common / name) for name in ("funasr_audio.h", "miniaudio.h")})
    write_json(output / "source.json", metadata)
    shutil.copyfile(source / "LICENSE", output / "FunASR-LICENSE.txt")


def extract(binary, build, output):
    binary, build, output = Path(binary).resolve(), Path(build), Path(output)
    samples = read_json(output / "samples.json")
    validate_selection(samples, samples)
    for folder in ("pcm", "features", "build"):
        (output / folder).mkdir(exist_ok=False)
    entries = []
    for sample in samples:
        sid = sample["id"]
        wav = output / "audio" / f"{sid}.wav"
        raw = read_bounded(wav, 960044)
        n = validate_wav(raw)
        if sha(raw) != sample["audio_sha256"]:
            raise ValueError("Extraction waveform changed")
        pcm, feature = output / "pcm" / f"{sid}.f32", output / "features" / f"{sid}.fbank"
        # This standalone extractor has no descendants, model or transcript output.
        subprocess.run([str(binary), str(wav), str(pcm), str(feature)], check=True, timeout=120,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pcm_bytes = read_bounded(pcm, n * 4)
        feature_bytes = read_bounded(feature, 8 + 500 * 560 * 4)
        validate_pcm(pcm_bytes, n)
        values = validate_feature(feature_bytes, n)
        entries.append({"id": sid, "frames": n, "shape": [len(values) // 560, 560],
                        "pcmSha256": sha(pcm_bytes), "featureSha256": sha(feature_bytes)})
    for name in ("extractor.cpp", "CMakeLists.txt", "source.json", "FunASR-LICENSE.txt", "build.log", "commands.txt"):
        shutil.copyfile(build / name, output / "build" / name)
    shutil.copyfile(build / "native/CMakeCache.txt", output / "build/CMakeCache.txt")
    compilers = list((build / "native/CMakeFiles").glob("*/CMakeCXXCompiler.cmake"))
    if len(compilers) != 1:
        raise ValueError("Missing unique compiler provenance")
    shutil.copyfile(compilers[0], output / "build/CMakeCXXCompiler.cmake")
    metadata = {"producer": sys.platform, **execution(), "platform": platform.platform(),
                "architecture": platform.machine(), "executableSha256": file_hash(binary),
                "generatedSha256": file_hash(build / "extractor.cpp"),
                "source": read_json(build / "source.json"), "samples": entries}
    write_json(output / "features.json", metadata)
    validate_bundle(output, samples, sys.platform, **execution())


def install(package, prior, output):
    package, output = Path(package).resolve(), Path(output)
    _, identity, _ = history(prior, sys.platform)
    raw = (package / "voice-package.json").read_bytes()
    if sha(raw) != identity["manifest"] or json.loads(raw)["modelId"] != "sensevoice-small-q8":
        raise ValueError("Installed package differs from historical engine")
    if sys.platform == "linux":
        for entry in json.loads(raw)["files"]:
            if entry["role"] == "binary":
                binary = (package / entry["path"]).resolve()
                if not binary.is_relative_to(package):
                    raise ValueError("Unsafe binary path")
                binary.chmod(0o755)
    environment = {k: v for k, v in os.environ.items() if not k.upper().startswith("VOICE_")}
    node = shutil.which("node")
    if not node:
        raise ValueError("Node is required for actual package installation")
    output.mkdir(parents=True, exist_ok=True)
    with (output / "installer-private.log").open("wb") as log:
        subprocess.run([node, "scripts/configure-voice.mjs", "--project-dir", str(Path.cwd()),
                        "--model", "sensevoice-small-q8", "--package-dir", str(package),
                        "--manifest-sha256", identity["manifest"], "--threads", "2", "--non-interactive"],
                       env=environment, stdout=log, stderr=log, check=True, timeout=180)
    helper = None
    if sys.platform == "win32":
        entry, = [e for e in json.loads(raw)["files"] if e["role"] == "helper"]
        helper = (package / entry["path"]).resolve()
        if not helper.is_relative_to(package) or file_hash(helper) != identity["helper"]:
            raise ValueError("Verified package helper differs")
    code = """
import { readFile } from 'node:fs/promises';
import { decodeEnvironment } from './scripts/voice/configuration-files.mjs';
import { voiceValues } from './scripts/voice/setup-config.mjs';
process.stdout.write(JSON.stringify(voiceValues(decodeEnvironment(await readFile('.env.local')))));
"""
    result = run_native(node, ["--input-type=module", "--eval", code], helper=helper, timeout=10)
    if result["failure"]:
        raise RuntimeError(f"Installed configuration read failed: {result['failure']}")
    values = json.loads(result["text"])
    expected = {"VOICE_ENABLED": "1", "VOICE_MODEL": "sensevoice-small-q8",
                "VOICE_THREADS": "2", "VOICE_RESOURCE_POLICY": "standard"}
    if any(values.get(k) != v for k, v in expected.items()):
        raise ValueError("Actual persisted configuration differs")
    paths = {"binary": values["VOICE_BINARY_PATH"], "model": values["VOICE_MODEL_PATH"],
             "helper": values.get("VOICE_LAUNCHER_PATH")}
    for role, path in paths.items():
        if (file_hash(path) if path else None) != identity[role]:
            raise ValueError("Actual installed role bytes differ")
    (output / "package-manifest.json").write_bytes(raw)
    return paths, identity


def consume(left, right, prior, package, output):
    output = Path(output)
    samples, expected_identity, _ = history(prior, sys.platform)
    roots = {"linux": Path(left), "win32": Path(right)}
    manifests = {}
    for producer, root in roots.items():
        manifests[producer], _ = validate_bundle(root, samples, producer, **execution())
    paths, identity = install(package, prior, output)
    if identity != expected_identity:
        raise ValueError("Consumer identity differs")
    environment = dict(os.environ)
    if paths["helper"]:
        environment["FEATURE_TEST_HELPER"] = paths["helper"]
    subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "scripts",
                    "-p", "test_voice_feature_process.py", "-v"], env=environment, check=True, timeout=120)
    write_json(output / "samples.json", samples)
    write_json(output / "environment.json", {
        **execution(), "consumer": sys.platform, "platform": platform.platform(),
        "architecture": platform.machine(), "identity": identity,
        "producerManifestSha256": {c: file_hash(root / "features.json") for c, root in roots.items()},
    })
    with (output / "attempts.jsonl").open("w", encoding="utf-8", buffering=1) as log:
        for repetition in (1, 2, 3):
            for sample in sorted(samples, key=lambda s: s["id"]):
                for source in SOURCES:
                    sid = sample["id"]
                    root = roots[sys.platform if source == "wav" else source]
                    input_file = root / ("audio" if source == "wav" else "features") / (
                        f"{sid}.wav" if source == "wav" else f"{sid}.fbank")
                    input_hash = file_hash(input_file)
                    entry = next(e for e in manifests[sys.platform if source == "wav" else source]["samples"]
                                 if e["id"] == sid)
                    expected_hash = sample["audio_sha256"] if source == "wav" else entry["featureSha256"]
                    if input_hash != expected_hash:
                        raise ValueError("Replay input changed after preflight")
                    outcome = run_native(paths["binary"], [
                        "-m", paths["model"], "-a" if source == "wav" else "-f", str(input_file.resolve()),
                        "--threads", "2", "--backend", "cpu"], helper=paths["helper"])
                    row = {**sample, "consumer": sys.platform, "repetition": repetition,
                           "input_source": source, "inputSha256": input_hash, "identity": identity, **outcome}
                    log.write(json.dumps(row, ensure_ascii=False) + "\n")
    write_json(output / "complete.json", {"consumer": sys.platform, "count": 108, **execution()})


def aggregate(producers, consumers, priors, output):
    producers, consumers, priors, output = map(Path, (producers, consumers, priors, output))
    samples, _, _ = history(priors / "linux", "linux")
    manifests, arrays, hosts, histories, rows = {}, {}, {}, {}, []
    for producer in CONSUMERS:
        manifests[producer], arrays[producer] = validate_bundle(
            producers / producer, samples, producer, **execution())
    if (manifests["linux"]["source"] != manifests["win32"]["source"]
            or manifests["linux"]["generatedSha256"] != manifests["win32"]["generatedSha256"]):
        raise ValueError("Producer source bytes differ")
    for consumer in CONSUMERS:
        selected, identity, histories[consumer] = history(priors / consumer, consumer)
        validate_selection(selected, samples)
        root = consumers / consumer
        if read_json(root / "complete.json") != {"consumer": consumer, "count": 108, **execution()}:
            raise ValueError("Consumer completion missing")
        validate_selection(read_json(root / "samples.json"), samples)
        host = read_json(root / "environment.json")
        if (host["consumer"] != consumer or host["identity"] != identity
                or any(host[k] != v for k, v in execution().items())
                or file_hash(root / "package-manifest.json") != identity["manifest"]
                or host["producerManifestSha256"] != {
                    c: file_hash(producers / c / "features.json") for c in CONSUMERS}):
            raise ValueError("Consumer provenance differs")
        attempts = read_rows(root / "attempts.jsonl")
        for row in attempts:
            if row["consumer"] != consumer or row["identity"] != identity:
                raise ValueError("Attempt engine identity differs")
            sample = next(s for s in samples if s["id"] == row["id"])
            source = row["input_source"]
            if source not in SOURCES:
                raise ValueError("Unexpected feature source")
            expected_hash = sample["audio_sha256"] if source == "wav" else next(
                s["featureSha256"] for s in manifests[source]["samples"] if s["id"] == row["id"])
            if row["inputSha256"] != expected_hash:
                raise ValueError("Attempt input hash differs")
        rows.extend(attempts)
        hosts[consumer] = host
    if hosts["linux"]["identity"]["model"] != hosts["win32"]["identity"]["model"]:
        raise ValueError("Consumer model weights differ")
    report = exchange_report(samples, rows, histories)
    report.update(environments=hosts, producers=manifests)
    report["numerical"] = []
    for sample in samples:
        sid = sample["id"]
        hashes = {c: next(s for s in manifests[c]["samples"] if s["id"] == sid) for c in CONSUMERS}
        report["numerical"].append({
            "id": sid, "dimensions": hashes["linux"]["shape"],
            **{name: {"hash_equal": hashes["linux"][field] == hashes["win32"][field],
                      **numeric_difference(arrays["linux"][sid][name], arrays["win32"][sid][name])}
               for name, field in (("pcm", "pcmSha256"), ("features", "featureSha256"))},
        })
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "summary.json", report)
    write_json(output / "samples.json", samples)
    invalid = [r["id"] for r in report["samples"] if r["classification"] == "invalid-controls"]
    lines = ["# Sense feature-boundary exchange", "", report["scope"], "",
             f"Delivered: {report['delivered']}/216. Controls pass: {report['controls_pass']}.",
             f"Classifications: {dict(Counter(s['classification'] for s in report['samples']))}",
             f"Invalid-control samples: {invalid}", "",
             "| Sample | PCM changed | Feature changed | Feature max abs | Classification |",
             "| --- | ---: | ---: | ---: | --- |"]
    for text, numbers in zip(report["samples"], report["numerical"]):
        lines.append(f"| {text['id']} | {numbers['pcm']['changed']} | {numbers['features']['changed']} | "
                     f"{numbers['features']['max_abs']:.9g} | {text['classification']} |")
    lines += ["", "No reference scoring, compiler attribution, latency approval or package promotion.",
              "Failed controls invalidate attribution for that sample; no global cause claim from a passing subset.",
              "Existing Windows quality failure and real Windows11/browser qualification remain open."]
    (output / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return int(not report["controls_pass"] or report["delivered"] != 216)


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Feature exchange executes only in GitHub Actions")
    action, *args = sys.argv[1:]
    commands = {"prepare": (prepare, 3), "generate": (generate_extractor, 3), "extract": (extract, 3),
                "consume": (consume, 5), "aggregate": (aggregate, 4)}
    if action not in commands or len(args) != commands[action][1]:
        raise ValueError("Invalid feature exchange command or argument count")
    return commands[action][0](*args) or 0


if __name__ == "__main__":
    sys.exit(main())
