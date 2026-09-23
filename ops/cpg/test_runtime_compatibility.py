"""Run in Actions only, against the unmodified official standalone CLI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    executable = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        probe = root / "probe.cjs"
        result = root / "result.json"
        probe.write_text(
            "require('node:fs').writeFileSync(process.env.CPG_PROBE_OUTPUT,"
            "JSON.stringify({pid:process.pid,node:process.version,"
            "heap:require('node:v8').getHeapStatistics().used_heap_size}));\n")
        env = dict(os.environ, NODE_OPTIONS="--require=" + str(probe),
                   CPG_PROBE_OUTPUT=str(result))
        completed = subprocess.run([executable, "--version"], env=env, text=True,
                                   capture_output=True, timeout=90, check=True)
        assert result.exists(), "Standalone CLI did not execute the NODE_OPTIONS preload"
        data = json.loads(result.read_text())
        assert data["heap"] > 0
        print("PASS: official CLI preload compatibility", completed.stdout.strip(), data)


if __name__ == "__main__":
    main()
