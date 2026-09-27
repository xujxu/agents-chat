"""Read retained voice ZIPs without executing or extracting native payloads."""

import hashlib
import json
import re
import stat
import zipfile
from pathlib import PurePosixPath

MAX_ARCHIVE = 512 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
MAX_ENTRIES = 4096
MAX_TEXT = 16 * 1024 * 1024
MAX_TEXT_TOTAL = 32 * 1024 * 1024
MAX_MANIFEST = 1024 * 1024
BOOKKEEPING = {"voice-package.json", "voice-package.sha256", "candidate.json", "candidate.sha256"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_stream(source, maximum, retain=False):
    digest, size, chunks = hashlib.sha256(), 0, []
    while chunk := source.read(1024 * 1024):
        size += len(chunk)
        require(size <= maximum, "Content exceeds size limit")
        digest.update(chunk)
        if retain:
            chunks.append(chunk)
    return size, digest.hexdigest(), b"".join(chunks)


def safe_path(name):
    require(isinstance(name, str) and re.fullmatch(r"[a-zA-Z0-9_./-]+", name),
            "Unsupported member path")
    require(all(part and part not in (".", "..") for part in name.split("/")),
            "Unsafe member path")
    require(all(not part.endswith(".") and not re.match(
        r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", part, re.I)
        for part in name.split("/")), "Nonportable member path")
    return name


def zip_inventory(z):
    entries = z.infolist()
    require(len(entries) <= MAX_ENTRIES, "Too many ZIP members")
    require(sum(item.file_size for item in entries) <= MAX_EXPANDED, "Expanded size exceeds limit")
    seen, files = {}, {}
    for item in entries:
        require(item.filename == item.orig_filename, "Truncated ZIP name")
        directory = item.is_dir()
        name = safe_path(item.filename[:-1] if directory else item.filename)
        key = name.lower()
        require(key not in seen, "Duplicate or case-colliding ZIP member")
        mode = stat.S_IFMT(item.external_attr >> 16)
        require(mode in (0, stat.S_IFDIR if directory else stat.S_IFREG),
                "Non-regular ZIP member")
        require(not item.flag_bits & 1, "Encrypted ZIP member")
        seen[key] = directory
        if not directory:
            files[name] = item
    for name in seen:
        for parent in PurePosixPath(name).parents:
            require(str(parent) == "." or seen.get(str(parent), True),
                    "ZIP file/directory collision")
    return files


def verify_manifest(manifest, entry, model_hash, files):
    require(isinstance(manifest, dict), "Manifest must be an object")
    windows = entry["platform"] == "win32"
    expected = {
        "modelId": entry["model"], "version": 2 if windows else 1,
        "platform": "windows-x64" if windows else "linux-x64",
        "cpuFlags": ["avx2", "fma", "f16c", "bmi2"],
        "qualification": "integration-candidate-not-release-approved",
        **({"minWindowsBuild": 19041, "helperProtocol": 2, "utf8Paths": True}
           if windows else {"minGlibc": "2.35"}),
    }
    require(all(manifest.get(key) == value for key, value in expected.items()),
            "Unexpected model/platform manifest")
    records = manifest.get("files")
    require(isinstance(records, list) and 2 <= len(records) <= 200, "Invalid manifest file list")
    by_path, roles = {}, []
    for record in records:
        require(isinstance(record, dict), "Invalid manifest record")
        name = safe_path(record.get("path"))
        require(name not in by_path and name not in BOOKKEEPING, "Duplicate/bookkeeping payload")
        require(type(record.get("bytes")) is int and 0 < record["bytes"] <= MAX_EXPANDED
                and isinstance(record.get("sha256"), str)
                and re.fullmatch(r"[0-9a-f]{64}", record["sha256"]), "Invalid payload identity")
        role = record.get("role")
        require(role in ("binary", "model", "license", "provenance", "helper"), "Invalid role")
        prefix = {"binary": "bin/", "helper": "bin/", "model": "models/",
                  "license": "licenses/", "provenance": "provenance/"}[role]
        require(name.startswith(prefix), "Payload role/path mismatch")
        require(name in files and files[name].file_size == record["bytes"], "Payload size/membership mismatch")
        if role == "model":
            require(record["sha256"] == model_hash, "Wrong model hash")
        if role == "helper":
            require(windows and name == "bin/voice-job.exe", "Unexpected helper")
        if windows and role == "binary":
            require(name.endswith(".exe"), "Unexpected Windows engine")
        by_path[name] = record
        roles.append(role)
    require(roles.count("binary") == roles.count("model") == 1
            and roles.count("helper") == int(windows), "Unexpected executable/model counts")
    require(set(files) - BOOKKEEPING == set(by_path), "Undeclared or missing payload")
    return by_path


def provenance_excerpt(name, text):
    if name.endswith("build.json"):
        value = json.loads(text)
        require(isinstance(value, dict), "Invalid build provenance")
        keys = ("applicationCommit", "modelId", "sourceRevision", "llamaRevision",
                "runnerOS", "osVersion", "architecture", "compiler", "cRuntime", "sourceArchives")
        return json.dumps({key: value[key] for key in keys if key in value}, indent=2) + "\n"
    if name.endswith("CMakeCache.txt"):
        keys = r"CMAKE_(?:BUILD_TYPE|C_COMPILER|CXX_COMPILER|MSVC_RUNTIME_LIBRARY|GENERATOR|EXE_LINKER_FLAGS)"
        return "\n".join(line for line in text.splitlines()
                         if re.match(rf"^{keys}:[A-Z_]+=", line)) + "\n"
    if name.endswith("helper-build.txt"):
        versions = re.findall(r"(?:Compiler Version|Compiler version|Version|Tools Version)\s+[\d.]+",
                              text, re.I)
        return "\n".join(sorted(set(versions))) + "\n"
    if name.endswith("-dependencies.txt") or name.endswith("linked-libraries.txt"):
        names = re.findall(r"\b[\w.+-]+\.(?:dll|so(?:\.\d+)*)\b", text, re.I)
        return "\n".join(sorted(set(names))) + "\n"
    if name.endswith("source-sha256.txt"):
        return "\n".join(line for line in text.splitlines()
                         if re.fullmatch(r"[0-9a-f]{64}\s+\*?[\w.-]+", line)) + "\n"
    if name.endswith("application-revision.txt"):
        return text.strip() + "\n" if re.fullmatch(r"[0-9a-f]{40}", text.strip()) else ""
    return ""


def evidence_rows(texts, windows):
    rows = []

    def check(identifier, name, markers):
        text = texts.get(name)
        normalized = " ".join(text.lower().split()) if text is not None else ""
        status = ("missing" if text is None else
                  "present" if all(marker in normalized for marker in markers)
                  else "needs-manual-review")
        rows.append({"id": identifier, "path": name, "status": status,
                     "reason": "Expected text markers identified; applicability not assessed."
                     if status == "present" else "Missing file or expected declaration not identified."})

    check("model-license", "licenses/model-card.txt", ("license: apache-2.0",))
    check("apache-text", "licenses/Apache-2.0.txt", ("apache license", "version 2.0"))
    for identifier, name in (("funasr", "licenses/FunASR-MIT.txt"),
                             ("ggml-llama", "licenses/llama-MIT.txt"),
                             ("jsonhpp", "licenses/llama-dependencies/LICENSE-jsonhpp")):
        check(identifier, name, ("copyright", "permission is hereby granted", "free of charge"))
    check("miniaudio", "licenses/miniaudio.h", ("mit no attribution", "permission is hereby granted"))
    if windows:
        check("runtime-review-notice", "licenses/RELEASE-REVIEW-REQUIRED.txt", ("msvc", "review"))
        reason = "Exact MSVC/SDK static-runtime redistribution grant and entitlement remain unconfirmed."
    else:
        check("gcc-exception", "licenses/gcc-runtime.txt",
              ("gcc runtime library exception", "version 3.1",
               "grant of additional permission", "eligible compilation processes"))
        check("gpl-text", "licenses/GPL-3.txt", ("gnu general public license", "version 3"))
        check("lgpl-text", "licenses/LGPL-2.1.txt", ("gnu lesser general public license", "version 2.1"))
        check("glibc-notice", "licenses/glibc.txt", ("copyright",))
        reason = "Retained exception text does not establish coverage of every linked runtime input."
    rows.append({"id": "runtime-rights", "path": None, "status": "needs-manual-review", "reason": reason})
    return rows


def inspect_archive(archive, entry, model_hash, output):
    require(archive.stat().st_size == entry["bytes"] <= MAX_ARCHIVE, "Archive size mismatch/limit")
    with archive.open("rb") as stream:
        size, digest, _ = read_stream(stream, MAX_ARCHIVE)
    require(digest == entry["archiveSha256"], "Archive hash mismatch")
    texts, retained, inventory = {}, {}, []
    with zipfile.ZipFile(archive) as z:
        members = zip_inventory(z)
        require("voice-package.json" in members, "Missing root manifest")
        with z.open(members["voice-package.json"]) as stream:
            _, manifest_hash, raw = read_stream(stream, MAX_MANIFEST, True)
        require(manifest_hash == entry["manifestSha256"], "Manifest hash mismatch")
        records = verify_manifest(json.loads(raw.decode("utf-8-sig")), entry, model_hash, members)
        bookkeeping = {"voice-package.json": raw}
        for name in sorted(set(members) & (BOOKKEEPING - {"voice-package.json"})):
            with z.open(members[name]) as stream:
                _, _, bookkeeping[name] = read_stream(stream, MAX_MANIFEST, True)
        for name in ("voice-package", "candidate"):
            checksum = bookkeeping.get(name + ".sha256")
            if checksum is not None:
                target = bookkeeping.get(name + ".json")
                require(target is not None, "Checksum without associated manifest")
                expected = hashlib.sha256(target).hexdigest() + "  " + name + ".json"
                require(checksum.decode("utf-8-sig").strip() == expected, "Bookkeeping checksum mismatch")
        if "candidate.json" in bookkeeping:
            candidate = json.loads(bookkeeping["candidate.json"].decode("utf-8-sig"))
            require(isinstance(candidate, dict) and candidate.get("modelId") == entry["model"]
                    and candidate.get("platform") == "windows-x64"
                    and isinstance(candidate.get("files"), list)
                    and all(isinstance(item, dict) for item in candidate["files"]),
                    "Invalid candidate bookkeeping")
            normalized = [dict(item, role="binary" if item.get("role") == "engine" else item.get("role"))
                          for item in candidate["files"] if isinstance(item, dict)]
            require(sorted(normalized, key=lambda item: item.get("path", "")) ==
                    sorted(records.values(), key=lambda item: item["path"]),
                    "Candidate and installation inventories differ")
        total_text = 0
        for name, record in sorted(records.items()):
            text_member = record["role"] in ("license", "provenance")
            maximum = MAX_TEXT if text_member else MAX_EXPANDED
            with z.open(members[name]) as stream:
                count, member_hash, raw = read_stream(stream, maximum, text_member)
            require(count == record["bytes"] and member_hash == record["sha256"], "Payload hash/size mismatch")
            inventory.append(dict(record, verified=True))
            if text_member:
                total_text += count
                require(total_text <= MAX_TEXT_TOTAL, "Retained text budget exceeded")
                text = raw.decode("utf-8-sig")
                if record["role"] == "license":
                    texts[name] = text
                    retained[name] = raw
                else:
                    excerpt = provenance_excerpt(name, text)
                    if excerpt.strip():
                        retained[name + ".excerpt.txt"] = excerpt.encode()
    retained_rows = []
    for name, data in sorted(retained.items()):
        destination = output / entry["platform"] / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        source = name.removesuffix(".excerpt.txt") if name.startswith("provenance/") else name
        retained_rows.append({"path": entry["platform"] + "/" + name,
                              "source_member": source, "source_sha256": records[source]["sha256"],
                              "retained_sha256": hashlib.sha256(data).hexdigest(),
                              "excerpt": name.startswith("provenance/")})
    return {
        "platform": entry["platform"], "expected": entry, "technical_status": "verified",
        "distribution_clearance": "not-assessed", "archive_bytes": size, "archive_sha256": digest,
        "manifest_sha256": manifest_hash, "files": inventory, "retained": retained_rows,
        "license_evidence": evidence_rows(texts, entry["platform"] == "win32"),
    }
