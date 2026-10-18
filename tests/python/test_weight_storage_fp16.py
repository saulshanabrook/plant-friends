from __future__ import annotations

from copy import deepcopy

import numpy as np
import onnx
import onnxruntime as ort
import pytest

from tools.plant_assets.weight_storage_fp16 import quantize_weight_storage


def test_storage_casts_preserve_fp32_arithmetic_and_match_quantized_weight_reference() -> None:
    weights = np.random.default_rng(4).uniform(-0.9, 0.9, (4, 4096)).astype(np.float32)
    bias = np.linspace(-0.01, 0.01, 4096, dtype=np.float32)
    graph = onnx.helper.make_graph([
        onnx.helper.make_node("MatMul", ["inputs", "weights"], ["linear"], name="linear"),
        onnx.helper.make_node("Add", ["linear", "bias"], ["output"], name="bias"),
    ], "tiny-storage-test", [onnx.helper.make_tensor_value_info("inputs", onnx.TensorProto.FLOAT, [1, 4])],
        [onnx.helper.make_tensor_value_info("output", onnx.TensorProto.FLOAT, [1, 4096])],
        initializer=[onnx.numpy_helper.from_array(weights, "weights"), onnx.numpy_helper.from_array(bias, "bias"),
                     onnx.numpy_helper.from_array(np.ones((2, 2), dtype=np.float32), "small")],
        value_info=[onnx.helper.make_tensor_value_info("linear", onnx.TensorProto.FLOAT, [1, 4096])])
    original = onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 17)], ir_version=10)
    quantized_reference = deepcopy(original)
    quantized_reference.graph.initializer[0].CopyFrom(onnx.numpy_helper.from_array(weights.astype(np.float16).astype(np.float32), "weights"))
    candidate = deepcopy(original)
    summary = quantize_weight_storage(candidate)
    onnx.checker.check_model(candidate)
    assert summary["selectedInitializers"] == 1
    assert summary["selectedElements"] == weights.size
    assert candidate.graph.initializer[0].name == "weights__fp16_storage"
    assert candidate.graph.initializer[0].data_type == onnx.TensorProto.FLOAT16
    assert candidate.graph.initializer[1] == original.graph.initializer[1]  # Rank-one bias at threshold stays FP32.
    assert candidate.graph.initializer[2] == original.graph.initializer[2]
    assert list(candidate.graph.node)[1:] == list(original.graph.node)
    assert list(candidate.graph.input) == list(original.graph.input)
    assert list(candidate.graph.output) == list(original.graph.output)
    assert list(candidate.graph.value_info) == list(original.graph.value_info)
    assert candidate.graph.node[0].op_type == "Cast"
    assert candidate.graph.node[0].output == ["weights"]
    assert candidate.graph.node[0].attribute[0].i == onnx.TensorProto.FLOAT
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.log_severity_level = 3
    source_session = ort.InferenceSession(quantized_reference.SerializeToString(), sess_options=options, providers=["CPUExecutionProvider"])
    candidate_session = ort.InferenceSession(candidate.SerializeToString(), sess_options=options, providers=["CPUExecutionProvider"])
    inputs = np.array([[0.125, -0.3, 0.7, 0.625]], dtype=np.float32)
    expected = source_session.run(["output"], {"inputs": inputs})[0]
    actual = candidate_session.run(["output"], {"inputs": inputs})[0]
    assert actual.dtype == np.float32
    np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize("value", [np.inf, np.nan, 1e10])
def test_storage_does_not_silently_clip_invalid_or_overflowing_weights(value: float) -> None:
    data = np.full((2, 2), value, dtype=np.float32)
    graph = onnx.helper.make_graph([], "invalid-weight", [], [], initializer=[onnx.numpy_helper.from_array(data, "weight")])
    model = onnx.helper.make_model(graph)
    with pytest.raises(ValueError, match="finite"):
        quantize_weight_storage(model, minimum_elements=1)


def test_nested_graph_storage_is_preserved_when_parent_nodes_are_rebuilt() -> None:
    branch = onnx.helper.make_graph([
        onnx.helper.make_node("MatMul", ["inputs", "branch_weight"], ["branch_output"]),
    ], "branch", [], [onnx.helper.make_tensor_value_info("branch_output", onnx.TensorProto.FLOAT, [1, 2])],
        initializer=[onnx.numpy_helper.from_array(np.ones((2, 2), dtype=np.float32), "branch_weight")])
    graph = onnx.helper.make_graph([
        onnx.helper.make_node("If", ["condition"], ["selected"], then_branch=branch, else_branch=deepcopy(branch)),
        onnx.helper.make_node("MatMul", ["selected", "parent_weight"], ["output"]),
    ], "parent", [onnx.helper.make_tensor_value_info("inputs", onnx.TensorProto.FLOAT, [1, 2]),
                  onnx.helper.make_tensor_value_info("condition", onnx.TensorProto.BOOL, [])],
        [onnx.helper.make_tensor_value_info("output", onnx.TensorProto.FLOAT, [1, 2])],
        initializer=[onnx.numpy_helper.from_array(np.eye(2, dtype=np.float32), "parent_weight")])
    model = onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 17)], ir_version=10)
    summary = quantize_weight_storage(model, minimum_elements=1)
    assert summary["selectedInitializers"] == 3
    onnx.checker.check_model(model)
    for node in model.graph.node:
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                assert attribute.g.initializer[0].data_type == onnx.TensorProto.FLOAT16
                assert [child.op_type for child in attribute.g.node] == ["Cast", "MatMul"]
