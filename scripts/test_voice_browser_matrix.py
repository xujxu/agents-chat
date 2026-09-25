import copy
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from test_voice_browser_report import fixture
from voice_browser_cases import CASES, IMPLEMENTATION_FILES, ROOT, validate_browser
from voice_browser_evidence import load_platform, main
from voice_browser_report import browser_report
from voice_feature_data import sha


def matrix_fixture():
    samples, rows, original, baseline = fixture()
    by_platform = {case["platform"]: name for name, case in CASES.items()}
    for row in rows + baseline:
        row["caseId"] = by_platform[row["platform"]]
    return samples, rows, original, baseline


def browser_fixture(case_id):
    case = CASES[case_id]
    settings = {"viewport": {"width": 393, "height": 660}, "isMobile": True, "hasTouch": True,
                "deviceScaleFactor": 3, "userAgent": "fixture"}
    return {**case, "caseId": case_id, "version": "147.0", "playwrightVersion": "1.58",
            "sourceRate": 48000, "userAgent": "fixture Edg/147.0",
            "requestedDeviceSettings": settings, "deviceSettings": copy.deepcopy(settings),
            "executable": {"path": "C:/Edge/msedge.exe", "version": "147.0", "sha256": "a" * 64}}


def artifact_fixture(root, case_id):
    samples, rows, _, _ = matrix_fixture()
    case = CASES[case_id]
    rows = [row for row in rows if row["caseId"] == case_id]
    raw = json.dumps({"files": [{"role": role, "sha256": sha(role.encode())}
                               for role in ("binary", "model")]}).encode()
    (root / "captured").mkdir()
    (root / "package-manifest.json").write_bytes(raw)
    for row in rows:
        if row["pipeline"] == "browser":
            n = int(row["uploadedDuration"] * 16000)
            wav = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36+n*2, b"WAVE", b"fmt ", 16,
                              1, 1, 16000, 32000, 2, 16, b"data", n*2) + struct.pack("<h", 100)*n
            row["uploadedAudioSha256"] = sha(wav)
            (root / "captured" / f"{row['id']}.wav").write_bytes(wav)
    contents = {
        "samples": samples,
        "complete": {"platform": case["platform"], "caseId": case_id, "sources": 100, "attempts": 200,
                     "model": "sensevoice-small-q8", "run": "1", "commit": "commit"},
        "status": {"caseId": case_id, "status": "complete", "run": "1", "commit": "commit"},
        "environment": {"platform": case["platform"], "caseId": case_id, "selectedCase": case,
                        "run": "1", "commit": "commit", "model": "sensevoice-small-q8", "threads": 2,
                        "manifestSha256": sha(raw),
                        "identity": {"manifest": sha(raw), "binary": sha(b"binary"), "model": sha(b"model"), "helper": None}},
        "browser": browser_fixture(case_id),
        "source-manifest": {"caseId": case_id, "samples": samples},
        "upload-manifest": {"caseId": case_id, "uploads": [
            {"caseId": case_id, "id": r["id"], "uploadedAudioSha256": r["uploadedAudioSha256"]}
            for r in rows if r["pipeline"] == "browser"]},
        "implementation": {name: sha((ROOT / name).read_bytes()) for name in IMPLEMENTATION_FILES},
    }
    for name, value in contents.items():
        (root / f"{name}.json").write_text(json.dumps(value), encoding="utf-8")
    (root / "results.jsonl").write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    return sha(raw)


class BrowserMatrixTests(unittest.TestCase):
    def test_fixed_cases_and_separate_case_cells(self):
        self.assertEqual(set(CASES), {"win32-edge", "linux-webkit-mobile"})
        report = browser_report(*matrix_fixture(), cases=CASES)
        self.assertEqual(report["attempts"], 400)
        self.assertTrue(report["primary_pass"])
        self.assertEqual({c["caseId"] for c in report["cells"]}, set(CASES))
        self.assertEqual(report["diagnostics"]["available"], 200)
        for item in report["cells"] + report["pairs"] + report["diagnostics"]["comparisons"]:
            self.assertEqual(item["platform"], CASES[item["caseId"]]["platform"])

    def test_reject_cross_case_baselines_and_legacy_or_wrong_attempts(self):
        for mutation in ("legacy", "unknown", "host", "duplicate", "baseline-case", "baseline-host", "hash"):
            samples, rows, original, baseline = matrix_fixture()
            if mutation == "legacy":
                del rows[0]["caseId"]
            elif mutation == "unknown":
                rows[0]["caseId"] = "desktop-chromium"
            elif mutation == "host":
                rows[0]["platform"] = "win32"
            elif mutation == "duplicate":
                rows[-1] = copy.deepcopy(rows[0])
            elif mutation == "baseline-case":
                baseline[0]["caseId"] = "win32-edge"
            elif mutation == "baseline-host":
                baseline[0]["platform"] = "win32"
            else:
                baseline[0]["uploadedAudioSha256"] = "b" * 64
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                browser_report(samples, rows, original, baseline, cases=CASES)

    def test_exact_browser_selection_and_no_fallback(self):
        for case_id in CASES:
            validate_browser(browser_fixture(case_id), case_id)
            for field, bad in (("caseId", "unknown"), ("browserName", "firefox"),
                               ("platform", "darwin"), ("device", "Pixel 7"),
                               ("project", "desktop-chromium"), ("channel", "chrome"),
                               ("sourceRate", 44100), ("version", ""), ("playwrightVersion", "")):
                browser = browser_fixture(case_id)
                browser[field] = bad
                with self.subTest(case=case_id, field=field), self.assertRaises(ValueError):
                    validate_browser(browser, case_id)
            browser = browser_fixture(case_id)
            browser["deviceSettings"]["hasTouch"] = False
            with self.assertRaises(ValueError):
                validate_browser(browser, case_id)
        for field, value in (("userAgent", "Chrome/147"), ("executable", None)):
            browser = browser_fixture("win32-edge")
            browser[field] = value
            with self.assertRaises(ValueError):
                validate_browser(browser, "win32-edge")

    def test_failure_null_timing_original_duration_and_thresholds(self):
        samples, rows, original, baseline = matrix_fixture()
        rows[1].update(failure="capture_failed", text=None, apiText=None, seconds=None, status=None,
                       apiElapsedMs=None, uploadedAudioSha256=None, uploadedDuration=None,
                       timing=None, capture=None)
        baseline[0].update(uploadedAudioSha256=None, text=None, failure="unavailable_input",
                           seconds=None, unavailable=True)
        for row in rows:
            if row["caseId"] == "win32-edge" and row["pipeline"] == "browser" and row["duration"] == 2:
                row["uploadedDuration"] = 5.1
                row["seconds"] = 3.001
                row["timing"].update(composerAt=4001, terminalAt=4001)
        report = browser_report(samples, rows, original, baseline, cases=CASES)
        self.assertFalse(report["primary_pass"])
        self.assertFalse(report["release_approved"])
        linux = next(c for c in report["cells"] if c["caseId"] == "linux-webkit-mobile" and c["pipeline"] == "browser")
        self.assertEqual(linux["delivered"], 99)
        self.assertIn("latency_incomplete:short", linux["violations"])
        self.assertTrue(any(v.startswith("quality:") for v in linux["violations"]))
        edge = next(c for c in report["cells"] if c["caseId"] == "win32-edge" and c["pipeline"] == "browser")
        self.assertIn("latency:short", edge["violations"])
        self.assertEqual(next(d for d in edge["duration"] if d["band"] == "short")["samples"], 50)

    def test_case_artifact_rejects_stale_metadata_fingerprints_and_corrupt_audio(self):
        case_id = "linux-webkit-mobile"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_hash = artifact_fixture(root, case_id)
            with patch("voice_browser_evidence.PACKAGE_HASHES", {"linux": manifest_hash}):
                self.assertEqual(len(load_platform(root, "linux", "1", "commit", case_id)[1]), 200)
                for name, field in (("complete", "caseId"), ("complete", "run"),
                                    ("environment", "caseId"), ("source-manifest", "caseId"),
                                    ("upload-manifest", "caseId"), ("browser", "device"),
                                    ("implementation", IMPLEMENTATION_FILES[0]), ("status", "status")):
                    path = root / f"{name}.json"
                    original = path.read_text()
                    changed = json.loads(original)
                    changed[field] = "invalid"
                    path.write_text(json.dumps(changed))
                    with self.subTest(file=name, field=field), self.assertRaises(ValueError):
                        load_platform(root, "linux", "1", "commit", case_id)
                    path.write_text(original)
                audio = root / "captured/s099.wav"
                audio.write_bytes(audio.read_bytes()[:-1] + b"x")
                with self.assertRaisesRegex(ValueError, "checksum"):
                    load_platform(root, "linux", "1", "commit", case_id)

    def test_missing_case_report_is_explicitly_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.dict("os.environ", {"GITHUB_RUN_ID": "1", "GITHUB_SHA": "commit"}):
                self.assertEqual(main([str(root / "evidence"), str(root / "baseline"), "short", "long",
                                       str(root / "report"), "matrix"]), 1)
            report = json.loads((root / "report/summary.json").read_text())
            self.assertEqual(report["status"], "incomplete")
            self.assertIsNone(report["primary_pass"])
            self.assertFalse(report["release_approved"])
            self.assertEqual(set(report["cases"]), set(CASES))


if __name__ == "__main__":
    unittest.main()
