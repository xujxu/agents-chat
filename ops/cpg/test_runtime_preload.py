"""Actions-only production-preload checks; no credentials or model calls."""
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

import memory_sampler_runtime as runtime
from memory_sampler_launch import cli_version

PRELOAD = Path(__file__).with_name("memory_sampler_preload.cjs").resolve()


def start(command, path, enabled=True, version="unavailable"):
    env = dict(os.environ, CPG_MEMORY_SOCKET=str(path))
    if enabled:
        env["CPG_MEMORY_CLI_VERSION"] = version
        command = ["bash", "-c", 'export CPG_MEMORY_PID=$$; exec "$@"', "fixture", *command]
    return subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def collect(collector, process, seconds):
    result = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        collector.wait(0.1)
        batch = collector.take()
        assert not batch["rejected"], batch
        result.extend(batch["samples"])
        if process.poll() is not None:
            break
    return result


def stop(process):
    if process.poll() is None:
        process.kill()
    return process.communicate(timeout=10)


def actual_cli(executable, root):
    path = root / "runtime.sock"
    with runtime.RuntimeCollector(path) as collector:
        # Hosted runners use v2; the real v1 boundary is tested in the separate VM.
        with patch.object(runtime.common, "memory_membership", return_value="/cpg.slice/test"):
            process = start([executable, "--node-options=--require=" + str(PRELOAD),
                             "--acp"], path, version=cli_version(executable))
            try:
                samples = collect(collector, process, 8)
                assert process.poll() is None, process.communicate()
                assert len(samples) >= 3, samples
                assert all(item["pid"] == process.pid for item in samples)
                assert all(item["metrics"]["heap_used_bytes"] > 0 for item in samples)
                assert all(item["metrics"]["schema"] == 2 for item in samples)
                assert all(item["metrics"]["versions"]["cli"] == "1.0.88" for item in samples)
                assert all(item["metrics"]["heap_physical_bytes"] > 0 for item in samples)
                assert samples[-1]["metrics"]["sequence"] > samples[0]["metrics"]["sequence"]
            finally:
                _, stderr = stop(process)
            assert "[cpg-memory] internal numeric sampling connected" in stderr, stderr
            print("PASS: original standalone CLI sends main-isolate metrics with real peer PID", flush=True)
            collector.wait(0.1)
            assert not collector.clients
            assert samples[-1]["metrics"]["heap_limit_bytes"] > 0


def fixture(root):
    script = root / "fixture.cjs"
    script.write_text(
        "const {Worker}=require('node:worker_threads');\n"
        "const held=Buffer.alloc(32*1024*1024,1);\n"
        "const worker=new Worker('setInterval(()=>{},1000)',{eval:true});\n"
        "const tick=setInterval(()=>{ held[0]++; const b=Buffer.alloc(1024*1024,1);"
        "if(global.gc)global.gc(); },500);\n"
        "setTimeout(()=>{clearInterval(tick);worker.terminate();"
        "console.log(JSON.stringify(process.resourceUsage()));},15000);\n")
    return script


def node_checks(root):
    path = root / "runtime.sock"
    script = fixture(root)
    observations = {False: [], True: []}
    for enabled in (False, True, False, True, False, True):
        with runtime.RuntimeCollector(path) as collector:
            with patch.object(collector, "_identity",
                              side_effect=lambda credentials: (credentials[0], 1)):
                args = [shutil.which("node"), "--expose-gc"]
                if enabled:
                    args += ["--require", str(PRELOAD)]
                process = start(args + [str(script)], path, enabled)
                try:
                    samples = collect(collector, process, 25)
                    output, error = process.communicate(timeout=5)
                    assert process.returncode == 0, error
                    usage = json.loads(output)
                    observations[enabled].append(usage)
                    if enabled:
                        assert len(samples) >= 5, samples
                        assert len({item["pid"] for item in samples}) == 1
                        assert collector.take()["connections"] <= 1
                        assert samples[-1]["metrics"]["gc_count"] > 0
                        assert max(s["metrics"]["array_buffers_bytes"] for s in samples) >= 32 * 1024**2
                    else:
                        assert not samples
                finally:
                    stop(process)
    cpu = {key: statistics.median((r["userCPUTime"] + r["systemCPUTime"]) / 1e6
                                 for r in rows) for key, rows in observations.items()}
    rss = {key: statistics.median(r["maxRSS"] * 1024 for r in rows)
           for key, rows in observations.items()}
    report = {"extra_one_core_cpu_percent": (cpu[True] - cpu[False]) / 15 * 100,
              "extra_peak_rss_bytes": rss[True] - rss[False], "raw": observations}
    print("OVERHEAD", json.dumps(report), flush=True)
    assert report["extra_one_core_cpu_percent"] < 1, report
    assert report["extra_peak_rss_bytes"] < 10 * 1024**2, report
    print("PASS: synthetic median overhead below 1% of one core and 10 MiB; not a CLI workload guarantee",
          flush=True)

    with runtime.RuntimeCollector(path) as collector:
        with patch.object(collector, "_identity", side_effect=lambda credentials: (credentials[0], 1)):
            process = start([shutil.which("node"), "--require", str(PRELOAD),
                             "-e", "setInterval(()=>{},1000)"], path)
            try:
                assert collect(collector, process, 3)
                for client in list(collector.clients):
                    collector._close(client)
                time.sleep(1)
                assert process.poll() is None
                samples = collect(collector, process, 14)
                assert samples, "Preload did not reconnect"
                assert samples[-1]["metrics"]["dropped_samples"] > 0
            finally:
                _, errors = stop(process)
            assert "disconnected" in errors
    print("PASS: disconnect is explicit, bounded and recovers without keeping CLI alive", flush=True)


def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        actual_cli(str(Path(sys.argv[1]).resolve()), root)
        node_checks(root)


if __name__ == "__main__":
    main()
