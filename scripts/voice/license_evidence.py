"""Actions-only retrieval and reporting for fixed, retained voice candidates."""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from license_archive import MAX_ARCHIVE, inspect_archive, require

API = "https://api.github.com"
READ_TIMEOUT = 30
TRANSFER_SECONDS = 300


def validate_metadata(value, entry, now=None):
    require(isinstance(value, dict), "Invalid artifact metadata")
    expected = {"id": entry["artifact"], "name": entry["name"], "expired": False,
                "size_in_bytes": entry["bytes"], "digest": "sha256:" + entry["archiveSha256"]}
    require(all(value.get(key) == item for key, item in expected.items())
            and value.get("expired") is False and 0 < entry["bytes"] <= MAX_ARCHIVE,
            "Artifact metadata identity mismatch")
    run = value.get("workflow_run")
    require(isinstance(run, dict) and all(run.get(key) == item for key, item in {
        "id": entry["run"], "head_sha": entry["commit"],
        "repository_id": entry["repositoryId"], "head_repository_id": entry["repositoryId"],
    }.items()), "Artifact run/repository mismatch")
    expires = value.get("expires_at")
    require(isinstance(expires, str), "Missing artifact expiry")
    try:
        expiry = datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Invalid artifact expiry") from None
    require(expiry.tzinfo is not None and expiry > (now or datetime.now(timezone.utc)),
            "Expired or timezone-less artifact")


def validate_catalog(catalog):
    require(isinstance(catalog, dict) and isinstance(catalog.get("catalogue"), dict)
            and set(catalog["catalogue"]) == {"linux", "win32"}, "Expected both fixed platforms")
    models = catalog.get("models")
    require(isinstance(models, dict) and isinstance(models.get("sensevoice-small-q8"), dict)
            and re.fullmatch(r"[0-9a-f]{64}", models["sensevoice-small-q8"].get("modelSha256", "")),
            "Missing selected model identity")
    for platform, entry in catalog["catalogue"].items():
        require(isinstance(entry, dict) and entry.get("platform") == platform
                and entry.get("repository") == "xujxu/agents-chat"
                and entry.get("repositoryId") == 1260147964
                and entry.get("model") == "sensevoice-small-q8", "Unsupported catalog entry")
        for key in ("artifact", "run", "bytes"):
            require(type(entry.get(key)) is int and entry[key] > 0, "Invalid catalog integer")
        for key, length in (("commit", 40), ("archiveSha256", 64), ("manifestSha256", 64)):
            require(isinstance(entry.get(key), str) and
                    re.fullmatch(r"[0-9a-f]{%d}" % length, entry[key]), "Invalid catalog hash")
        require(isinstance(entry.get("name"), str) and entry["name"], "Missing artifact name")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def safe_error(error):
    if isinstance(error, urllib.error.HTTPError):
        return f"HTTP request failed with status {error.code}"
    if isinstance(error, urllib.error.URLError):
        return "Network request failed (URL and credentials withheld)"
    return str(error)


def api_response(path, token):
    request = urllib.request.Request(API + path, headers={
        "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agents-chat-voice-license-evidence",
    })
    return urllib.request.build_opener(NoRedirect).open(request, timeout=READ_TIMEOUT)


def download_entry(entry, directory, token):
    base = f"/repos/{entry['repository']}/actions/artifacts/{entry['artifact']}"
    with api_response(base, token) as response:
        require(response.status == 200, "Unexpected metadata status")
        raw = response.read(64 * 1024 + 1)
        require(len(raw) <= 64 * 1024, "Oversized metadata")
    metadata = json.loads(raw)
    validate_metadata(metadata, entry)
    # Follow the API's signed-object redirect without forwarding Authorization.
    try:
        response = api_response(base + "/zip", token)
    except urllib.error.HTTPError as error:
        try:
            require(error.code == 302, f"Archive API returned HTTP {error.code}")
            location = error.headers.get("Location", "")
        finally:
            error.close()
    else:
        response.close()
        raise ValueError("Expected archive API redirect")
    parsed = urllib.parse.urlsplit(location)
    require(parsed.scheme == "https" and parsed.hostname and not parsed.username
            and not parsed.password and parsed.port in (None, 443), "Unsafe archive redirect")
    destination = directory / (entry["platform"] + ".zip")
    partial = directory / (entry["platform"] + ".partial")
    deadline, count, digest = time.monotonic() + TRANSFER_SECONDS, 0, hashlib.sha256()
    try:
        with urllib.request.build_opener(NoRedirect).open(location, timeout=READ_TIMEOUT) as source:
            require(source.status == 200, "Unexpected archive status")
            length = source.headers.get("Content-Length")
            require(length is None or int(length) == entry["bytes"], "Unexpected download length")
            with partial.open("xb") as target:
                while True:
                    require(time.monotonic() < deadline, "Archive download deadline exceeded")
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    require(count <= min(entry["bytes"], MAX_ARCHIVE), "Oversized download")
                    digest.update(chunk)
                    target.write(chunk)
        require(count == entry["bytes"] and digest.hexdigest() == entry["archiveSha256"],
                "Downloaded archive identity mismatch")
        partial.replace(destination)
        (directory / (entry["platform"] + ".metadata.json")).write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    finally:
        partial.unlink(missing_ok=True)


def inspect_all(catalog, downloads, output):
    validate_catalog(catalog)
    require(not output.exists() or not any(output.iterdir()), "Report directory must be empty")
    output.mkdir(parents=True, exist_ok=True)
    summary = {
        "reviewed_commit": os.environ.get("GITHUB_SHA"),
        "inspection_run": os.environ.get("GITHUB_RUN_ID"),
        "distribution_clearance": "not-assessed",
        "scope": "Only retained Linux/Windows SenseVoiceSmall q8 candidates",
        "excluded": ["Whisper archives", "old application components", "test audio", "public release"],
        "candidates": [], "errors": [],
    }
    model_hash = catalog["models"]["sensevoice-small-q8"]["modelSha256"]
    for platform, entry in sorted(catalog["catalogue"].items()):
        try:
            metadata = json.loads((downloads / (platform + ".metadata.json")).read_text(encoding="utf-8"))
            validate_metadata(metadata, entry)
            summary["candidates"].append(
                inspect_archive(downloads / (platform + ".zip"), entry, model_hash, output))
        except (OSError, ValueError, zipfile.BadZipFile, NotImplementedError) as error:
            summary["errors"].append({"platform": platform, "stage": "archive-inspection",
                                      "error": safe_error(error), "expected": entry})
    summary["technical_status"] = "incomplete" if summary["errors"] else "verified"
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    report = [
        "# Retained voice candidate license evidence", "",
        "Scope: Linux and Windows SenseVoiceSmall q8 only.",
        "Technical inspection is NOT distribution clearance. Windows runtime rights remain unconfirmed.",
        "Whisper, old application dependencies, test audio and publication are excluded.", "",
        f"Reviewed commit: `{summary['reviewed_commit']}`; inspection run: `{summary['inspection_run']}`.",
        f"Technical status: **{summary['technical_status']}**.", "",
    ]
    for candidate in summary["candidates"]:
        report.extend([
            f"## {candidate['platform']}", "",
            f"Artifact `{candidate['expected']['artifact']}`; original run `{candidate['expected']['run']}`.",
            f"Archive SHA-256: `{candidate['archive_sha256']}`.",
            f"Manifest SHA-256: `{candidate['manifest_sha256']}`.",
            f"All {len(candidate['files'])} declared payloads verified; no payload executed.", "",
            "| Evidence | Status | Member |", "| --- | --- | --- |",
        ])
        for row in candidate["license_evidence"]:
            report.append(f"| {row['id']} | {row['status']} | {row['path'] or '-'} |")
        report.extend(["", candidate["license_evidence"][-1]["reason"], ""])
    for error in summary["errors"]:
        report.extend([f"## Incomplete: {error['platform']}", "", error["error"], ""])
    (output / "REPORT.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    return not summary["errors"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("download", "inspect"))
    parser.add_argument("catalog", type=Path)
    parser.add_argument("downloads", type=Path)
    parser.add_argument("output", nargs="?", type=Path)
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true", "Run this collector in GitHub Actions only")
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    validate_catalog(catalog)
    if args.operation == "inspect":
        require(args.output is not None, "Report directory required")
        return 0 if inspect_all(catalog, args.downloads, args.output) else 1
    require(args.output is None, "Download does not accept a report directory")
    token = os.environ.get("GH_TOKEN")
    require(token, "Scoped GitHub token required for retrieval")
    args.downloads.mkdir(parents=True, exist_ok=False)
    failures = []
    for platform, entry in sorted(catalog["catalogue"].items()):
        try:
            download_entry(entry, args.downloads, token)
            print(f"{platform}: fixed archive downloaded and verified")
        except (OSError, ValueError) as error:
            failures.append({"platform": platform, "error": safe_error(error)})
            print(f"{platform}: {safe_error(error)}", file=sys.stderr)
    if failures:
        (args.downloads / "download-errors.json").write_text(json.dumps(failures, indent=2) + "\n")
    return int(bool(failures))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(safe_error(error), file=sys.stderr)
        sys.exit(1)
