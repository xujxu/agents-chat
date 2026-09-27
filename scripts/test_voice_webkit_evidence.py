import copy
from pathlib import Path
import tempfile
import unittest
import zipfile

from voice_browser_cases import CASES
from voice_browser_evidence import BASELINE_ARCHIVES
from voice_webkit_evidence import (CASE, INPUTS, SOURCE_COMMIT, SOURCE_RUN, extract_verified,
                                   file_hash, validate_history, validate_metadata)


class WebkitEvidenceTests(unittest.TestCase):
    def test_fixed_artifact_identity_and_historical_commit(self):
        artifact_id, run, name, digest = INPUTS["webkit"]
        metadata = {"id": int(artifact_id), "expired": False, "name": name, "digest": "sha256:" + digest,
                    "workflow_run": {"id": int(run), "head_sha": SOURCE_COMMIT}}
        self.assertEqual(validate_metadata(metadata, "webkit"), digest)
        for field, value in (("id", 1), ("expired", True), ("name", "other"), ("digest", "sha256:" + "0" * 64),
                             ("workflow_run", {"id": 1, "head_sha": SOURCE_COMMIT}),
                             ("workflow_run", {"id": int(run), "head_sha": "new-analysis-commit"})):
            changed = {**metadata, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_metadata(changed, "webkit")

    def test_archive_checksum_and_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for i, name in enumerate(("report.json", "../escape", "/absolute", "a\\escape", "C:/escape")):
                archive = root / f"{i}.zip"
                with zipfile.ZipFile(archive, "w") as stream:
                    stream.writestr(name, "{}")
                if i == 0:
                    with self.assertRaisesRegex(ValueError, "digest"):
                        extract_verified(archive, root / "bad", "0" * 64)
                    extract_verified(archive, root / "good", file_hash(archive))
                    self.assertEqual((root / "good/report.json").read_text(), "{}")
                else:
                    with self.assertRaisesRegex(ValueError, "Unsafe"):
                        extract_verified(archive, root / f"out{i}", file_hash(archive))

    def test_historical_baseline_not_analysis_identity_and_exact_arguments(self):
        complete = {"count": 200, "run": SOURCE_RUN, "commit": SOURCE_COMMIT, "cases": list(CASES)}
        environment = {**complete, "archives": BASELINE_ARCHIVES, "threads": 2, "timeout": 120,
                       "arguments": ["--num-threads=2", "--provider=cpu", "--debug=0", "--tokens=/sense/tokens.txt",
                                     "--sense-voice-model=/sense/model.int8.onnx",
                                     "--sense-voice-language=auto", "--sense-voice-use-itn=1"]}
        host = {"host": {"run": SOURCE_RUN, "commit": SOURCE_COMMIT}}
        matrix = {"status": "complete", "attempts": 400, "cases": list(CASES), "release_approved": False,
                  "environments": {CASE: host}, "baseline_environment": environment}
        validate_history(complete, environment, matrix, host)
        with self.assertRaises(ValueError):
            validate_history({**complete, "commit": "analysis"}, environment, matrix, host)
        for field, value in (("threads", 1), ("run", "new"), ("archives", {}),
                             ("arguments", environment["arguments"][:-1])):
            changed = {**environment, field: value}
            saved = copy.deepcopy(matrix)
            saved["baseline_environment"] = changed
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_history(complete, changed, saved, host)


if __name__ == "__main__":
    unittest.main()
