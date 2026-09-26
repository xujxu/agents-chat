import hashlib
import json
import stat
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "voice"))
import license_archive
from license_archive import inspect_archive
from license_evidence import inspect_all, validate_metadata


def sha(data):
    return hashlib.sha256(data).hexdigest()


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def fixture(self, platform="linux", omit=(), extra=None, bad_member=False,
                manifest_update=None):
        windows = platform == "win32"
        files = {
            "bin/engine.exe" if windows else "bin/engine": b"NOT EXECUTABLE",
            "models/model.gguf": b"NOT A MODEL",
            "licenses/model-card.txt": b"---\nlicense: apache-2.0\n---\n",
            "licenses/Apache-2.0.txt": b"Apache License\nVersion 2.0\n",
            "licenses/FunASR-MIT.txt": b"Copyright FunASR\nPermission is hereby granted, free of charge",
            "licenses/llama-MIT.txt": b"Copyright ggml\nPermission is hereby granted, free of charge",
            "licenses/llama-dependencies/LICENSE-jsonhpp": b"Copyright JSON\nPermission is hereby granted, free of charge",
            "licenses/miniaudio.h": b"ALTERNATIVE 2 - MIT No Attribution\nPermission is hereby granted, free of charge",
        }
        if windows:
            files["bin/voice-job.exe"] = b"NOT A HELPER"
            files["licenses/RELEASE-REVIEW-REQUIRED.txt"] = b"MSVC static runtime redistribution requires review"
            files["provenance/helper-build.txt"] = b"Compiler Version 19.44\nSECRET_ENV=not-for-report\n"
        else:
            files["licenses/gcc-runtime.txt"] = (
                b"GCC RUNTIME LIBRARY EXCEPTION\nVersion 3.1\n"
                b"Grant of Additional Permission\nEligible Compilation Processes"
            )
            files["licenses/GPL-3.txt"] = b"GNU GENERAL PUBLIC LICENSE\nVersion 3"
            files["licenses/LGPL-2.1.txt"] = b"GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1"
            files["licenses/glibc.txt"] = b"GNU C Library copyright"
        for name in omit:
            del files[name]
        records = []
        for name, data in files.items():
            role = ("helper" if name == "bin/voice-job.exe" else
                    "binary" if name.startswith("bin/") else
                    "model" if name.startswith("models/") else
                    "license" if name.startswith("licenses/") else "provenance")
            records.append({"path": name, "role": role, "bytes": len(data), "sha256": sha(data)})
        manifest = {
            "version": 2 if windows else 1,
            "platform": "windows-x64" if windows else "linux-x64",
            "modelId": "sensevoice-small-q8",
            "cpuFlags": ["avx2", "fma", "f16c", "bmi2"],
            "qualification": "integration-candidate-not-release-approved",
            "files": records,
        }
        manifest.update({"minWindowsBuild": 19041, "helperProtocol": 2, "utf8Paths": True}
                        if windows else {"minGlibc": "2.35"})
        manifest.update(manifest_update or {})
        raw = json.dumps(manifest).encode()
        files["voice-package.json"] = raw
        files["voice-package.sha256"] = (sha(raw) + "  voice-package.json\n").encode()
        if bad_member:
            files["models/model.gguf"] = b"BAD A MODEL"
        archive = self.root / (platform + ".zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in files.items():
                z.writestr(name, data)
            if extra:
                z.writestr(*extra)
        entry = {
            "platform": platform, "model": "sensevoice-small-q8",
            "repository": "xujxu/agents-chat", "repositoryId": 1260147964,
            "artifact": 123 if windows else 124, "run": 456, "commit": "a" * 40,
            "name": "fixture", "bytes": archive.stat().st_size,
            "archiveSha256": sha(archive.read_bytes()), "manifestSha256": sha(raw),
        }
        return archive, entry, sha(b"NOT A MODEL")

    def inspect(self, fixture):
        return inspect_archive(*fixture, self.root / "output")

    def test_valid_platform_reports_never_grant_distribution(self):
        for platform in ("linux", "win32"):
            with self.subTest(platform=platform):
                result = self.inspect(self.fixture(platform))
                self.assertEqual(result["technical_status"], "verified")
                self.assertEqual(result["distribution_clearance"], "not-assessed")
                self.assertTrue(any(row["status"] == "needs-manual-review"
                                    for row in result["license_evidence"]))
                self.assertEqual(result["archive_sha256"], result["expected"]["archiveSha256"])
        self.assertFalse(list((self.root / "output").rglob("*.exe")))
        self.assertFalse(list((self.root / "output").rglob("*.gguf")))
        self.assertTrue(list((self.root / "output").rglob("FunASR-MIT.txt")))
        for file in (self.root / "output").rglob("*"):
            if file.is_file():
                self.assertNotIn(b"SECRET_ENV", file.read_bytes())

    def test_missing_notices_reported_not_approved(self):
        result = self.inspect(self.fixture(omit=("licenses/Apache-2.0.txt",)))
        row = next(row for row in result["license_evidence"] if row["id"] == "apache-text")
        self.assertEqual(row["status"], "missing")
        self.assertEqual(result["distribution_clearance"], "not-assessed")

    def test_identity_and_payload_mismatches(self):
        for key in ("bytes", "archiveSha256", "manifestSha256"):
            with self.subTest(key=key):
                archive, entry, model = self.fixture()
                entry[key] = entry[key] + 1 if key == "bytes" else "0" * 64
                with self.assertRaises(ValueError):
                    self.inspect((archive, entry, model))
        with self.assertRaises(ValueError):
            self.inspect(self.fixture(bad_member=True))
        with self.assertRaises(ValueError):
            self.inspect(self.fixture(manifest_update={"platform": "other"}))
        archive, entry, model = self.fixture()
        with self.assertRaises(ValueError):
            self.inspect((archive, entry, "0" * 64))

    def test_unsafe_or_undeclared_members_rejected(self):
        for name in ("../escape", "/absolute", "C:/drive", "a\\b",
                     "licenses/./odd", "LICENSES/MODEL-CARD.TXT",
                     "licenses", "bin/engine/child", "undeclared.txt"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.inspect(self.fixture(extra=(name, b"unexpected")))
        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ValueError):
            self.inspect(self.fixture(extra=(link, b"target")))

    def test_size_limits(self):
        for constant, limit in (("MAX_ARCHIVE", 1), ("MAX_EXPANDED", 1),
                                ("MAX_ENTRIES", 1), ("MAX_TEXT", 1),
                                ("MAX_TEXT_TOTAL", 1), ("MAX_MANIFEST", 1)):
            with self.subTest(constant=constant):
                fixture = self.fixture()
                with patch.object(license_archive, constant, limit), self.assertRaises(ValueError):
                    self.inspect(fixture)

    def metadata(self, entry):
        return {
            "id": entry["artifact"], "name": entry["name"], "expired": False,
            "size_in_bytes": entry["bytes"], "digest": "sha256:" + entry["archiveSha256"],
            "expires_at": "2030-01-01T00:00:00Z",
            "workflow_run": {"id": entry["run"], "head_sha": entry["commit"],
                             "repository_id": entry["repositoryId"],
                             "head_repository_id": entry["repositoryId"]},
        }

    def test_metadata_exact_identity_and_expiry(self):
        _, entry, _ = self.fixture()
        now = datetime(2026, 9, 26, tzinfo=timezone.utc)
        validate_metadata(self.metadata(entry), entry, now)
        for field, value in (("id", 999), ("name", "other"), ("expired", True),
                             ("size_in_bytes", 2), ("digest", "sha256:wrong"),
                             ("expires_at", "2020-01-01T00:00:00Z"),
                             ("expires_at", "2030-01-01"), ("expires_at", "invalid"),
                             ("workflow_run", {"id": 456})):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                metadata = self.metadata(entry)
                metadata[field] = value
                validate_metadata(metadata, entry, now)

    def test_partial_report_on_missing_download(self):
        catalog = {"catalogue": {}, "models": {"sensevoice-small-q8": {}}}
        for platform in ("linux", "win32"):
            archive, entry, model = self.fixture(platform)
            catalog["catalogue"][platform] = entry
            catalog["models"]["sensevoice-small-q8"]["modelSha256"] = model
            (self.root / (platform + ".metadata.json")).write_text(json.dumps(self.metadata(entry)))
        (self.root / "win32.zip").unlink()
        output = self.root / "report"
        self.assertFalse(inspect_all(catalog, self.root, output))
        report = json.loads((output / "summary.json").read_text())
        self.assertEqual(report["distribution_clearance"], "not-assessed")
        self.assertEqual(len(report["candidates"]), 1)
        self.assertEqual(len(report["errors"]), 1)
        self.assertIn("Windows", (output / "REPORT.md").read_text())


if __name__ == "__main__":
    unittest.main()
