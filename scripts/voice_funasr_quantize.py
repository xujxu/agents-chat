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

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def quantize(source, destination, mode):
    if mode not in ("u8s8", "u8s8-rr", "u8u8"):
        raise ValueError(f"Unsupported quantization mode: {mode}")
    source, destination = Path(source), Path(destination)
    source_model = onnx.load(source, load_external_data=False)
    metadata = {p.key: p.value for p in source_model.metadata_props}
    inputs = [x.SerializeToString() for x in source_model.graph.input]
    outputs = [x.SerializeToString() for x in source_model.graph.output]
    del source_model
    destination.parent.mkdir(parents=True, exist_ok=True)
    unsigned = mode == "u8u8"
    quantize_dynamic(
        str(source), str(destination),
        weight_type=QuantType.QUInt8 if unsigned else QuantType.QInt8,
        per_channel=True, reduce_range=mode == "u8s8-rr",
        extra_options={"WeightSymmetric": not unsigned},
        use_external_data_format=True,
    )
    model = onnx.load(destination, load_external_data=False)
    assert [x.SerializeToString() for x in model.graph.input] == inputs, "Input interface changed"
    assert [x.SerializeToString() for x in model.graph.output] == outputs, "Output interface changed"
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
    }
    destination.with_suffix(".json").write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    quantize(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
