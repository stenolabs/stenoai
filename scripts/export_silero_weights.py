"""Export Silero VAD v5's 16 kHz weights from the ONNX file to an .npz.

macOS runs Silero in plain numpy (src/silero_vad.py, ``_NumpySilero``) so the
bundle does not need onnxruntime (~60 MB) for a 1 MB model. This one-off dev
script pulls the 16 kHz branch's tensors out of src/data/silero_vad.onnx into
src/data/silero_vad_16k.npz. Re-run it only if the ONNX model is replaced.

Needs the ``onnx`` package, which is NOT an app dependency:
    pip install onnx && python scripts/export_silero_weights.py
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

ROOT = Path(__file__).resolve().parents[1]
ONNX_PATH = ROOT / "src" / "data" / "silero_vad.onnx"
NPZ_PATH = ROOT / "src" / "data" / "silero_vad_16k.npz"

# PyTorch parameter names as they appear (suffixed) on the ONNX Constants.
WEIGHTS = [
    "stft.forward_basis_buffer",
    *[f"encoder.{i}.reparam_conv.{p}" for i in range(4) for p in ("weight", "bias")],
    "decoder.rnn.weight_ih",
    "decoder.rnn.weight_hh",
    "decoder.rnn.bias_ih",
    "decoder.rnn.bias_hh",
    "decoder.decoder.2.weight",
    "decoder.decoder.2.bias",
]


def main() -> None:
    model = onnx.load(str(ONNX_PATH))
    # The top-level graph is `If(sr == 16000)`; then_branch is the 16 kHz model.
    top_if = next(n for n in model.graph.node if n.op_type == "If")
    branch = next(a.g for a in top_if.attribute if a.name == "then_branch")
    constants = {
        node.output[0]: numpy_helper.to_array(node.attribute[0].t)
        for node in branch.node
        if node.op_type == "Constant"
    }
    arrays = {}
    for name in WEIGHTS:
        matches = [k for k in constants if k.endswith("__" + name)]
        if len(matches) != 1:
            raise SystemExit(f"expected one constant for {name}, found {matches}")
        arrays[name] = constants[matches[0]].astype(np.float32)
    arrays["source_onnx_sha256"] = np.array(hashlib.sha256(ONNX_PATH.read_bytes()).hexdigest())
    np.savez(NPZ_PATH, **arrays)
    print(f"wrote {NPZ_PATH} ({NPZ_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
