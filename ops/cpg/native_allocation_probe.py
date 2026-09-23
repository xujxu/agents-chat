"""Actions-only heaptrack feasibility experiment; never attaches to a live CLI."""
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys
import time

from native_probe_report import MIB, assess, overhead, parse_stacks, stack_bytes
from native_probe_capture import capture

SOURCE = Path(__file__).resolve().parent


def run(command, directory, env, expected=(0,), timeout=60):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    with (directory / "stdout.txt").open("w") as out, (directory / "stderr.txt").open("w") as err:
        process = subprocess.Popen(command, env=env, cwd=directory,
                                   stdin=subprocess.PIPE, stdout=out, stderr=err)
        try:
            code = process.wait(timeout=timeout)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if code not in expected:
        raise RuntimeError("Unexpected exit {} in {}; inspect stdout/stderr".format(code, directory))
    return {"exit_code": code, "wall_seconds": time.monotonic() - started,
            "cpu_seconds": after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime}


def analyze(directory, env):
    captures = list(directory.glob("trace.gz")) + list(directory.glob("trace.zst"))
    if len(captures) != 1 or captures[0].stat().st_size == 0:
        raise RuntimeError("Expected one nonempty heaptrack capture in " + str(directory))
    result = {}
    for cost in ("peak", "leaked"):
        output = directory / (cost + ".stacks")
        analysis = directory / ("analysis-" + cost)
        analysis.mkdir()
        run(["heaptrack_print", str(captures[0]), "--merge-backtraces=0",
             "--print-allocators=0", "--print-temporary=0", "--print-leaks=1",
             "--flamegraph-cost-type=" + cost, "--print-flamegraph=" + str(output)],
            analysis, env)
        result[cost] = parse_stacks(output.read_text())
    return result


def clean_environment(home):
    home.mkdir()
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"), "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8", "DEBUGINFOD_URLS": ""}


def execute(root, name, command, tracked=False, abrupt=False, cli=False):
    directory = root / name
    directory.mkdir()
    env = clean_environment(directory / "home")
    if cli:
        env.update(CPG_NATIVE_PROBE_MARKER=str(directory / "markers.jsonl"),
                   CPG_NATIVE_PROBE_KILL="1" if abrupt else "0")
    expected = (-9,) if abrupt else (0,)
    result = (capture(command, directory, env, expected) if tracked
              else run(command, directory, env, expected=expected))
    if cli:
        markers = [json.loads(line) for line in (directory / "markers.jsonl").read_text().splitlines()]
        if [m["phase"] for m in markers] != ["start", "peak", "released", "finished"]:
            raise RuntimeError("Incomplete standalone CLI fixture phases")
        if markers[1]["memory"]["arrayBuffers"] - markers[0]["memory"]["arrayBuffers"] < 47 * MIB:
            raise RuntimeError("Standalone fixture did not allocate the known buffers")
        if markers[1]["memory"]["arrayBuffers"] - markers[2]["memory"]["arrayBuffers"] < 31 * MIB:
            raise RuntimeError("Standalone fixture did not release the transient buffer")
        result["max_rss_bytes"] = markers[-1]["usage"]["maxRSS"] * 1024
        result["versions"] = markers[-1]["versions"]
    else:
        markers = [json.loads(line.removeprefix("CPG_PROBE "))
                   for line in (directory / "stdout.txt").read_text().splitlines()
                   if line.startswith("CPG_PROBE ")]
        if len(markers) != 1:
            raise RuntimeError("Missing native fixture completion marker")
        result.update(markers[0])
    (directory / "resources.json").write_text(json.dumps(result, indent=2) + "\n")
    if sum(p.stat().st_size for p in root.rglob("*") if p.is_file()) > 128 * MIB:
        raise RuntimeError("Experiment exceeded 128 MiB between-run artifact budget")
    return result, analyze(directory, env) if tracked else None


def native_accounting(stacks):
    expected = {"cpg_probe_release": 32 * MIB, "cpg_probe_keep": 16 * MIB,
                "cpg_probe_resize": 24 * MIB, "cpg_probe_worker": 8 * MIB}
    actual = {name: {"peak": stack_bytes(stacks["peak"], name),
                     "outstanding": stack_bytes(stacks["leaked"], name)} for name in expected}
    passed = all(actual[name]["peak"] == size and
                 actual[name]["outstanding"] == (16 * MIB if name == "cpg_probe_keep" else 0)
                 for name, size in expected.items())
    return passed, actual


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("This experiment is Actions-only; do not run it on the production host")
    executable, root = (Path(arg).resolve() for arg in sys.argv[1:])
    root.mkdir(exist_ok=True)
    if any(root.iterdir()):
        raise RuntimeError("Use an empty experiment output directory")
    for tool in ("cc", "heaptrack", "heaptrack_print", "readelf"):
        if not shutil.which(tool):
            raise RuntimeError("Missing experiment tool: " + tool)
    if shutil.which("heaptrack_gui"):
        raise RuntimeError("Use headless heaptrack without its automatic GUI")
    environment = clean_environment(root / "build-home")
    build = root / "build"
    build.mkdir()
    fixture = build / "native-fixture"
    run(["cc", "-O0", "-g", "-Wall", "-Wextra", "-Werror", "-fno-omit-frame-pointer",
         "-rdynamic", "-pthread", str(SOURCE / "native_probe_fixture.c"), "-o", str(fixture)],
        build, environment)
    digest = hashlib.sha256()
    with executable.open("rb") as binary:
        for chunk in iter(lambda: binary.read(1024 * 1024), b""):
            digest.update(chunk)
    metadata = {"cli_sha256": digest.hexdigest(),
                "heaptrack": subprocess.check_output(["heaptrack", "--version"], text=True).strip(),
                "cli_build_id_section": subprocess.check_output(
                    ["readelf", "-x", ".note.gnu.build-id", str(executable)], text=True, timeout=10),
                "production_limits_changed": False}
    (root / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    summary = {"production_ready": False, "root_cause_proven": False, "status": "incomplete"}
    try:
        _, normal = execute(root, "native-normal", [str(fixture)], tracked=True)
        _, killed = execute(root, "native-killed", [str(fixture), "kill"], tracked=True, abrupt=True)
        exact, accounting = native_accounting(normal)
        killed_exact, killed_accounting = native_accounting(killed)
        args = [str(executable),
                "--node-options=--expose-gc --require=" + str(SOURCE / "native_probe_fixture.cjs"),
                "--acp"]
        base, tracked = [], []
        named_bytes = []
        for index in range(3):
            baseline, _ = execute(root, "cli-baseline-" + str(index), args, cli=True)
            instrumented, stacks = execute(root, "cli-tracked-" + str(index), args, tracked=True, cli=True)
            base.append(baseline)
            tracked.append(instrumented)
            named_bytes.append(sum(value for stack, value in stacks["peak"]
                                   if any(name in stack for name in (
                                       "ArrayBuffer", "BackingStore", "node::Buffer"))))
        _, killed_cli = execute(root, "cli-killed", args, tracked=True, abrupt=True, cli=True)
        killed_named = sum(value for stack, value in killed_cli["peak"]
                           if any(name in stack for name in ("ArrayBuffer", "BackingStore", "node::Buffer")))
        measured = overhead(base, tracked)
        summary = assess(exact, min(named_bytes), killed_exact and killed_named >= 32 * MIB, measured)
        summary.update(status="completed", overhead=measured, native_accounting=accounting,
                       native_killed_accounting=killed_accounting, cli_named_peak_bytes=named_bytes,
                       cli_killed_named_peak_bytes=killed_named)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        summary["error"] = "{}: {}".format(type(error).__name__, error)
        raise
    finally:
        (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
