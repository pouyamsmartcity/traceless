"""Stores an ONNX model's float32 weights as float16, converted back to float32 when the model loads.

The model still computes in float32 (same results as the original, within float16 rounding of the weights),
but the file is half the size. Used for the person detector (YOLOX-s):

    python3 scripts/half_weights.py yolox_s.onnx public/models/person-yolox-s.onnx
"""
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def main(src: str, dst: str) -> None:
    model = onnx.load(src)
    graph = model.graph
    halves, casts = [], []
    for init in list(graph.initializer):
        arr = numpy_helper.to_array(init)
        if arr.dtype != np.float32 or arr.size <= 16:
            continue
        halves.append(numpy_helper.from_array(arr.astype(np.float16), init.name + '_h'))
        casts.append(helper.make_node('Cast', [init.name + '_h'], [init.name], to=TensorProto.FLOAT, name='cast_' + init.name))
        graph.initializer.remove(init)
    graph.initializer.extend(halves)
    nodes = list(graph.node)
    del graph.node[:]
    graph.node.extend(casts + nodes)
    onnx.checker.check_model(model)
    onnx.save(model, dst)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
