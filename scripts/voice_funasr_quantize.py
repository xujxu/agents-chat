"""CI-only LLM requantization, leaving the audio encoder and tokenizer unchanged.

Recipe: Wasser1462/FunASR-nano-onnx at
6823a8ed9f4a0393750d54d750051cf5a51a7fa9,
scripts/export_llm_onnx_u8u8.py. The freshly generated full-range signed
variant is a control for conversion-tool differences versus the shipped model.
"""

import hashlib
import json
from pathlib import Path
import sys
import tempfile

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def interface(values):
    return [{
        "name": value.name, "dtype": value.type.tensor_type.elem_type,
        "shape": [
            dim.dim_value if dim.HasField("dim_value") else dim.dim_param or None
            for dim in value.type.tensor_type.shape.dim
        ] if value.type.tensor_type.HasField("shape") else None,
    } for value in values]


def check_interface(before, after):
    if len(before) != len(after):
        raise ValueError(f"Interface count changed: {before} -> {after}")
    for old, new in zip(before, after):
        if old["name"] != new["name"] or old["dtype"] != new["dtype"]:
            raise ValueError(f"Interface name/type changed: {old} -> {new}")
        # Shape inference may rename symbols or refine previously unknown dimensions.
        if old["shape"] is not None:
            if new["shape"] is None or len(old["shape"]) != len(new["shape"]):
                raise ValueError(f"Interface rank changed: {old} -> {new}")
            for left, right in zip(old["shape"], new["shape"]):
                if isinstance(left, int) and left != right:
                    raise ValueError(f"Static interface dimension changed: {old} -> {new}")


def quantize(source, destination, mode):
    if mode not in ("u8s8", "u8s8-rr", "u8u8"):
        raise ValueError(f"Unsupported quantization mode: {mode}")
    source, destination = Path(source), Path(destination)
    source_model = onnx.load(source, load_external_data=False)
    metadata = {p.key: p.value for p in source_model.metadata_props}
    inputs = interface(source_model.graph.input)
    outputs = interface(source_model.graph.output)
    versions = {op.version for op in source_model.opset_import if op.domain in ("", "ai.onnx")}
    if len(versions) != 1:
        raise ValueError("Missing or conflicting standard ONNX opsets")
    retained = [op for op in source_model.opset_import if op.domain not in ("", "ai.onnx")]
    del source_model.opset_import[:]
    source_model.opset_import.extend([onnx.helper.make_opsetid("", versions.pop()), *retained])
    def normalize_domains(graph):
        for node in graph.node:
            if node.domain == "ai.onnx":
                node.domain = ""
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.GRAPH:
                    normalize_domains(attr.g)
                elif attr.type == onnx.AttributeProto.GRAPHS:
                    for child in attr.graphs:
                        normalize_domains(child)
    normalize_domains(source_model.graph)
    destination.parent.mkdir(parents=True, exist_ok=True)
    unsigned = mode == "u8u8"
    # Keep the temporary graph next to its unchanged relative external weights.
    with tempfile.NamedTemporaryFile(suffix=".onnx", dir=source.parent) as normalized:
        onnx.save_model(source_model, normalized.name)
        del source_model
        quantize_dynamic(
            normalized.name, str(destination),
            weight_type=QuantType.QUInt8 if unsigned else QuantType.QInt8,
            per_channel=True, reduce_range=mode == "u8s8-rr",
            extra_options={"WeightSymmetric": not unsigned},
            use_external_data_format=False,
        )
    model = onnx.load(destination, load_external_data=False)
    assert not any(t.external_data for t in model.graph.initializer), "Expected self-contained runtime model"
    inferred_inputs, inferred_outputs = interface(model.graph.input), interface(model.graph.output)
    check_interface(inputs, inferred_inputs)
    check_interface(outputs, inferred_outputs)
    expected = onnx.TensorProto.UINT8 if unsigned else onnx.TensorProto.INT8
    weights = [x for x in model.graph.initializer if x.name.endswith("_quantized")]
    assert weights and all(x.data_type == expected for x in weights), "Unexpected quantized weights"
    metadata.update({"quantization_type": "int8", "int8_mode": mode})
    onnx.helper.set_model_props(model, metadata)
    onnx.save_model(model, destination)
    onnx.checker.check_model(str(destination))
    report = {
        "mode": mode, "source_sha256": checksum(source),
        "model_sha256": checksum(destination), "quantized_weight_tensors": len(weights),
        "per_channel": True, "reduce_range": mode == "u8s8-rr",
        "weight_type": "QUInt8" if unsigned else "QInt8",
        "metadata": metadata,
        "source_interface": {"inputs": inputs, "outputs": outputs},
        "inferred_interface": {"inputs": inferred_inputs, "outputs": inferred_outputs},
    }
    destination.with_suffix(".json").write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    quantize(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
