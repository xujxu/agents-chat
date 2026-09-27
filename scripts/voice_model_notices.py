"""Collect scoped public weight permission evidence, not a blanket legal clearance."""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import urllib.request


def weight_evidence(metadata, files, actual, mapping):
    license_name = metadata.get("License")
    if license_name not in ("apache-2.0", "mit", "bsd-2-clause", "bsd-3-clause"):
        raise ValueError("Missing or non-whitelist published weight license")
    published = {row["Path"]: row for row in files}
    if not mapping:
        raise ValueError("No declared weight identity scope")
    comparisons = []
    for local, remote in mapping.items():
        if local not in actual or remote not in published:
            raise ValueError("Missing requested weight identity")
        source = published[remote]
        if not source.get("Sha256") or not source.get("Revision"):
            raise ValueError("Incomplete publisher identity")
        comparisons.append({"artifact_path": local, "published_path": remote,
                            "published_sha256": source["Sha256"], "artifact_sha256": actual[local],
                            "published_revision": source["Revision"],
                            "identical": source["Sha256"] == actual[local]})
    return {"declared_weight_license": license_name, "comparisons": comparisons,
            "weights_matched": all(row["identical"] for row in comparisons),
            "complete_package_approved": False,
            "scope": "Explicit permission declaration and byte identity for named files only. "
                     "Does not approve converter code, local derivatives or all binary dependencies."}


def download(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def collect(evidence, destination):
    evidence, destination = Path(evidence), Path(destination)
    destination.mkdir(exist_ok=False)
    actual = {}
    for line in (evidence / "provenance/model-files.sha256").read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        if name in actual:
            raise ValueError("Duplicate artifact identity")
        actual[name] = digest
    models = {
        "FunASR-nano-onnx": {
            "original/embedding.int8.onnx": "embedding.int8.onnx",
            "original/Qwen3-0.6B/tokenizer.json": "Qwen3-0.6B/tokenizer.json",
            "original/Qwen3-0.6B/merges.txt": "Qwen3-0.6B/merges.txt",
            "original/Qwen3-0.6B/vocab.json": "Qwen3-0.6B/vocab.json",
        },
        "Qwen3-ASR-onnx": {
            "qwen/conv_frontend.onnx": "model_0.6B/conv_frontend.onnx",
            "qwen/encoder.int8.onnx": "model_0.6B/encoder.int8.onnx",
            "qwen/decoder.int8.onnx": "model_0.6B/decoder.int8.onnx",
            "qwen/tokenizer/merges.txt": "tokenizer/merges.txt",
            "qwen/tokenizer/vocab.json": "tokenizer/vocab.json",
            "qwen/tokenizer/tokenizer_config.json": "tokenizer/tokenizer_config.json",
        },
    }
    results = {}
    for name, mapping in models.items():
        url = f"https://www.modelscope.cn/api/v1/models/zengshuishui/{name}"
        metadata = json.loads(download(url))
        files_url = f"{url}/repo/files?Revision=master&Recursive=true"
        listing = json.loads(download(files_url))
        if metadata.get("Success") is not True or listing.get("Success") is not True:
            raise ValueError("Publisher metadata retrieval unsuccessful")
        result = weight_evidence(metadata["Data"], listing["Data"]["Files"], actual, mapping)
        results[name] = {**result, "metadata_url": url, "file_listing_url": files_url,
                         "observed_utc": datetime.now(timezone.utc).isoformat()}
        (destination / f"{name}.json").write_text(json.dumps(results[name], indent=2))
    notices = {
        "sherpa-Apache-2.0.txt": "https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE",
        "ort-MIT.txt": "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE",
        "ort-third-party-superset.txt": "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/ThirdPartyNotices.txt",
        "ort-cpu-build.yml": "https://raw.githubusercontent.com/csukuangfj/onnxruntime-libs/v1.28.2/.github/workflows/linux-shared-217.yaml",
        "tokenizer-Qwen3-Apache-2.0.txt": "https://huggingface.co/Qwen/Qwen3-0.6B/raw/c1899de289a04d12100db370d81485cdf75e47ca/LICENSE",
        "simple-sentencepiece-Apache-2.0.txt": "https://raw.githubusercontent.com/pkufool/simple-sentencepiece/v0.7/LICENSE",
    }
    notice_evidence = []
    for name, url in notices.items():
        content = download(url)
        (destination / name).write_bytes(content)
        notice_evidence.append({"file": name, "url": url,
                                "sha256": hashlib.sha256(content).hexdigest()})
    summary = {
        "weights": results, "notices": notice_evidence, "installation_approved": False,
        "remaining_scope": [
            "Nano encoder/LLM are our U8U8 derivatives from pinned FP32 sources; "
            "see quantization Actions35619891005, archive92ac72f74ce5e621564f7693de5d383fa11b1ad836fc0bbfc14ed7cb4cc68509.",
            "Converter repositories lack independent LICENSE files; do not distribute that code "
            "or infer its permission from separately Apache-licensed output weights.",
            "ORT third-party notice file is a superset, not proof every optional component is linked.",
            "Native build/transitive notices and system-library obligations must accompany any install bundle.",
            "Licensing declarations do not establish accuracy, hardware compatibility or product acceptance.",
        ],
    }
    (destination / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({name: {"license": result["declared_weight_license"],
                             "named_files_match": result["weights_matched"]}
                      for name, result in results.items()}, indent=2))


if __name__ == "__main__":
    collect(*sys.argv[1:])
