import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from voice_funasr_quantize import check_interface, quantize


class QuantizationTests(unittest.TestCase):
    def test_modes_preserve_interface_metadata_and_weight_ranges(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.onnx"
            graph = helper.make_graph(
                [helper.make_node("MatMul", ["x", "weight"], ["y"])], "test",
                [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 2])],
                [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 2])],
                [numpy_helper.from_array(np.array([[-2, 1], [1, 2]], dtype=np.float32), "weight")],
            )
            model = helper.make_model(graph, opset_imports=[
                helper.make_opsetid("", 17), helper.make_opsetid("ai.onnx", 17)])
            model.ir_version = 9
            helper.set_model_props(model, {"model_type": "test", "max_total_len": "1024"})
            onnx.save(model, source)
            for mode in ("u8s8", "u8s8-rr", "u8u8"):
                with self.subTest(mode=mode):
                    destination = root / f"{mode}.onnx"
                    report = quantize(source, destination, mode)
                    result = onnx.load(destination)
                    self.assertEqual(result.graph.input[0].name, "x")
                    self.assertEqual(result.graph.output[0].name, "y")
                    self.assertEqual(dict((p.key, p.value) for p in result.metadata_props)["max_total_len"], "1024")
                    weights = next(t for t in result.graph.initializer if t.name == "weight_quantized")
                    expected = TensorProto.UINT8 if mode == "u8u8" else TensorProto.INT8
                    self.assertEqual(weights.data_type, expected)
                    if mode == "u8s8-rr":
                        self.assertLessEqual(int(np.abs(numpy_helper.to_array(weights).astype("int16")).max()), 64)
                    self.assertGreater(report["quantized_weight_tensors"], 0)

    def test_invalid_mode_rejected(self):
        with self.assertRaises(ValueError):
            quantize(Path("missing"), Path("unused"), "invalid")

    def test_shape_inference_refinement_not_interface_change(self):
        before = [{"name": "x", "dtype": 1, "shape": ["batch", None, 64]}]
        check_interface(before, [{"name": "x", "dtype": 1, "shape": [1, "sequence", 64]}])
        for changed in (
            {"name": "x", "dtype": 1, "shape": [1, "sequence", 32]},
            {"name": "x", "dtype": 10, "shape": [1, "sequence", 64]},
            {"name": "x", "dtype": 1, "shape": [1, 64]},
        ):
            with self.assertRaises(ValueError):
                check_interface(before, [changed])


if __name__ == "__main__":
    unittest.main()
