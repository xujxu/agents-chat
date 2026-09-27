import csv
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
import wave

from voice_blind_package import package


class BlindPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.rows = []
        for index in range(40):
            identifier = f"source-{index:02d}"
            path = self.source / f"{identifier}.wav"
            with wave.open(str(path), "wb") as stream:
                stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                stream.writeframes(struct.pack("<h", index) * (16000 * 15))
            # Metadata must not leak the source's caption into the listening file.
            data = path.read_bytes()
            metadata = b"LIST" + struct.pack("<I", 16) + b"SECRET-CAPTION!!"
            metadata += b"\0"
            data = data[:4] + struct.pack("<I", len(data) + len(metadata) - 8) + data[8:] + metadata
            path.write_bytes(data)
            self.rows.append({
                "id": identifier, "audio_sha256": hashlib.sha256(data).hexdigest(),
                "duration": 15, "source_url": "https://example.org/source.tar.gz",
                "archive_member": f"original/{identifier}.wav", "start": 10, "end": 25,
                "caption": "SECRET-CAPTION", "reference": "SECRET-REFERENCE",
            })
        self.save()

    def save(self):
        (self.source / "samples.json").write_text(json.dumps(self.rows), encoding="utf-8")

    def test_exact_blind_contents_blank_csv_and_reversible_mapping(self):
        output = self.root / "output"
        package(self.source, output)
        blind = output / "blind"
        ids = [f"{index:02d}" for index in range(1, 41)]
        self.assertEqual(
            {str(path.relative_to(blind)) for path in blind.rglob("*") if path.is_file()},
            {f"audio/{identifier}.wav" for identifier in ids}
            | {"transcripts.csv", "README.txt", "ATTRIBUTION.txt"},
        )
        self.assertTrue((blind / "transcripts.csv").read_bytes().startswith(b"\xef\xbb\xbf"))
        with (blind / "transcripts.csv").open(encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual([row["id"] for row in rows], ids)
        self.assertTrue(all(set(row) == {"id", "transcript", "notes"} for row in rows))
        self.assertTrue(all(row["transcript"] == row["notes"] == "" for row in rows))
        mapping = json.loads((output / "key" / "mapping.json").read_text())
        self.assertEqual([row["blind_id"] for row in mapping], ids)
        self.assertCountEqual([row["source_id"] for row in mapping], [row["id"] for row in self.rows])
        self.assertNotEqual([row["source_id"] for row in mapping], [row["id"] for row in self.rows])
        for row in mapping:
            original = self.source / f"{row['source_id']}.wav"
            target = blind / "audio" / f"{row['blind_id']}.wav"
            with wave.open(str(original)) as a, wave.open(str(target)) as b:
                self.assertEqual(a.getparams(), b.getparams())
                self.assertEqual(a.readframes(a.getnframes()), b.readframes(b.getnframes()))
            self.assertNotIn(b"SECRET-CAPTION", target.read_bytes())
            self.assertEqual(row["source_sha256"], hashlib.sha256(original.read_bytes()).hexdigest())
            self.assertEqual(row["blind_sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        for path in output.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"SECRET-REFERENCE", path.read_bytes())
                self.assertNotIn(b"SECRET-CAPTION", path.read_bytes())
        self.assertEqual(
            (output / "csv" / "transcripts.csv").read_bytes(),
            (blind / "transcripts.csv").read_bytes(),
        )

    def test_mapping_and_audio_are_reproducible(self):
        package(self.source, self.root / "first")
        package(self.source, self.root / "second")
        for path in (self.root / "first").rglob("*"):
            if path.is_file():
                self.assertEqual(path.read_bytes(), (self.root / "second" / path.relative_to(self.root / "first")).read_bytes())

    def test_rejects_wrong_count_duplicate_id_and_unsafe_id(self):
        for change in ("count", "duplicate", "unsafe"):
            with self.subTest(change=change):
                original = [dict(row) for row in self.rows]
                if change == "count":
                    self.rows.pop()
                elif change == "duplicate":
                    self.rows[0]["id"] = self.rows[1]["id"]
                else:
                    self.rows[0]["id"] = "../escape"
                self.save()
                with self.assertRaises(ValueError):
                    package(self.source, self.root / change)
                self.rows = original
                self.save()

    def test_rejects_missing_audio(self):
        (self.source / "source-00.wav").unlink()
        with self.assertRaises(ValueError):
            package(self.source, self.root / "output")

    def test_rejects_checksum_mismatch(self):
        self.rows[0]["audio_sha256"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(ValueError, "checksum"):
            package(self.source, self.root / "output")

    def test_rejects_truncated_audio_even_with_matching_checksum(self):
        path = self.source / "source-00.wav"
        path.write_bytes(path.read_bytes()[:100])
        self.rows[0]["audio_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.save()
        with self.assertRaises(ValueError):
            package(self.source, self.root / "output")

    def test_rejects_unexpected_format_or_duration(self):
        for rate, seconds in ((8000, 15), (16000, 1)):
            with self.subTest(rate=rate, seconds=seconds):
                path = self.source / "source-00.wav"
                with wave.open(str(path), "wb") as stream:
                    stream.setparams((1, 2, rate, 0, "NONE", "not compressed"))
                    stream.writeframes(b"\0\0" * rate * seconds)
                self.rows[0]["audio_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                self.save()
                with self.assertRaises(ValueError):
                    package(self.source, self.root / f"output-{rate}")

    def test_does_not_reuse_output_directory(self):
        output = self.root / "output"
        output.mkdir()
        (output / "old-captions.txt").write_text("stale")
        with self.assertRaises(FileExistsError):
            package(self.source, output)


if __name__ == "__main__":
    unittest.main()
