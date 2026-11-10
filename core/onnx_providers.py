"""Which ONNX Runtime execution provider the optional speech models run on, for whoever runs Kairos.

The order is the best this machine's runtime offers: DirectML on Windows (any DirectX 12 graphics card: NVIDIA, AMD or
Intel; the Windows build ships onnxruntime-directml), Core ML on macOS when the runtime has it, otherwise the processor.
The processor is always the last entry, so a graphics provider that fails to load or to run falls back to it (the
callers in core/kokoro_voice.py do that, and remember the failure for the rest of the session).

Smart Turn is not routed through here: its model is the int8 CPU export and DirectML cannot run it (a Reshape fails,
measured 2026-11-09), and on the processor it already answers in about 30 ms.

DirectML also cannot run one shape of operator Kokoro v1.0 uses: a grouped (depthwise) 1-D ConvTranspose with stride 2
(the upsampling "pool" layers; DirectML fails with "The parameter is incorrect"). `dml_compatible_model` rewrites each
one, in memory, into the exact same arithmetic DirectML can run: interleave zeros, then a grouped Conv with the kernel
reversed. The file on disk (whose SHA-256 is pinned) is never changed. Checked against the original on the processor:
identical output, sample for sample.
"""
import logging
import struct
import sys

logger = logging.getLogger(__name__)

CPU = "CPUExecutionProvider"
DML = "DmlExecutionProvider"
COREML = "CoreMLExecutionProvider"

# What Settings > Speech says, in plain words.
LABELS = {
    DML: "the graphics card (DirectML)",
    COREML: "Apple's Core ML (graphics and Neural Engine)",
    CPU: "the processor",
}

# Graphics providers worth trying first, per platform. Anything else the runtime offers is ignored on purpose:
# CUDA and others need their own large installs and are not what users get.
_PREFERRED = {"win32": [DML], "darwin": [COREML]}


def available() -> list[str]:
    """The providers this onnxruntime build has; empty when onnxruntime is missing or broken."""
    try:
        import onnxruntime
        return list(onnxruntime.get_available_providers())
    except Exception:
        return []


def candidates(platform: str | None = None, have: list[str] | None = None, skip=()) -> list[str]:
    """Providers to try, best first, always ending with the processor. `skip` drops ones that already failed."""
    platform = platform or sys.platform
    have = available() if have is None else have
    order = [p for p in _PREFERRED.get(platform, []) if p in have and p not in skip]
    return order + [CPU]


def label(provider: str | None) -> str:
    return LABELS.get(provider or CPU, provider or LABELS[CPU])


def session(model_path: str, provider: str):
    """An InferenceSession on exactly `provider` (with the processor behind it for any operator the provider does not
    take). Raises whatever onnxruntime raises; the caller decides on the fallback."""
    import onnxruntime as ort
    options = ort.SessionOptions()
    if provider == CPU:
        return ort.InferenceSession(model_path, sess_options=options, providers=[CPU])
    if provider == DML:
        # DirectML's documented requirements: no memory patterns, sequential execution.
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        with open(model_path, "rb") as handle:
            data, rewritten = dml_compatible_model(handle.read())
        if rewritten:
            logger.info("onnx: %d grouped ConvTranspose layer(s) rewritten for DirectML in %s", len(rewritten), model_path)
        made = ort.InferenceSession(data, sess_options=options, providers=[DML, CPU])
        del data
        return made
    return ort.InferenceSession(model_path, sess_options=options, providers=[provider, CPU])


# -- the DirectML rewrite: ONNX protobuf read and written at the wire level, so no `onnx` package is needed ------------

def _varint(b, i):
    result = shift = 0
    while True:
        c = b[i]
        i += 1
        result |= (c & 0x7F) << shift
        shift += 7
        if c < 0x80:
            return result, i


def _enc_varint(value):
    if value < 0:
        value += 1 << 64
    out = bytearray()
    while True:
        c = value & 0x7F
        value >>= 7
        if value:
            out.append(c | 0x80)
        else:
            out.append(c)
            return bytes(out)


def _fields(b, start, end):
    """(field number, wire type, value or (start, end) span of the payload, (start, end) of the whole field)."""
    i = start
    while i < end:
        begin = i
        key, i = _varint(b, i)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(b, i)
            yield number, wire, value, (begin, i)
        elif wire == 1:
            yield number, wire, (i, i + 8), (begin, i + 8)
            i += 8
        elif wire == 5:
            yield number, wire, (i, i + 4), (begin, i + 4)
            i += 4
        elif wire == 2:
            size, i = _varint(b, i)
            yield number, wire, (i, i + size), (begin, i + size)
            i += size
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")


def _len(number, payload):
    return _enc_varint((number << 3) | 2) + _enc_varint(len(payload)) + payload


def _int(number, value):
    return _enc_varint(number << 3) + _enc_varint(value)


def _str(number, text):
    return _len(number, text.encode())


def _attr_int(name, value):            # AttributeProto: name=1, i=3, type=20 (INT=2)
    return _len(5, _str(1, name) + _int(3, value) + _int(20, 2))


def _attr_ints(name, values):          # ints=8, type INTS=7
    return _len(5, _str(1, name) + b"".join(_int(8, v) for v in values) + _int(20, 7))


def _tensor_int64(values):             # TensorProto: dims=1, data_type=2 (INT64=7), raw_data=9
    return _int(1, len(values)) + _int(2, 7) + _len(9, struct.pack(f"<{len(values)}q", *values))


def _tensor_float(value):              # a scalar, FLOAT=1
    return _int(2, 1) + _len(9, struct.pack("<f", value))


def _constant(name, tensor):           # NodeProto: output=2, name=3, op_type=4, attribute=5 (TENSOR=4, t=5)
    return _len(1, _str(2, name) + _str(3, name) + _str(4, "Constant") + _len(5, _str(1, "value") + _len(5, tensor) + _int(20, 4)))


def _node(op, inputs, outputs, name, attributes=b""):
    return _len(1, b"".join(_str(1, x) for x in inputs) + b"".join(_str(2, x) for x in outputs) + _str(3, name) + _str(4, op) + attributes)


def _parse_node(b, span):
    info = {"inputs": [], "outputs": [], "name": "", "op": "", "domain": "", "attrs": {}}
    for number, wire, value, _ in _fields(b, *span):
        if number in (1, 2, 3, 4, 7):
            text = bytes(b[value[0]:value[1]]).decode()
            key = {1: "inputs", 2: "outputs", 3: "name", 4: "op", 7: "domain"}[number]
            if number in (1, 2):
                info[key].append(text)
            else:
                info[key] = text
        elif number == 5:
            name, ints, single, other = None, [], None, False
            for n3, w3, v3, _ in _fields(b, *value):
                if n3 == 1:
                    name = bytes(b[v3[0]:v3[1]]).decode()
                elif n3 == 3:
                    single = v3 - (1 << 64) if v3 >= 1 << 63 else v3
                elif n3 == 8:
                    if w3 == 0:
                        ints.append(v3)
                    else:
                        j = v3[0]
                        while j < v3[1]:
                            x, j = _varint(b, j)
                            ints.append(x)
                elif n3 in (2, 4, 5, 6, 7, 9, 10, 11):
                    other = True
            info["attrs"][name] = "other" if other else (single if single is not None else ints)
    return info


def _rewrite_conv_transpose(info, tag):
    """The replacement nodes for one ConvTranspose, or None when it is not the shape DirectML fails on."""
    a = info["attrs"]
    group, kernel, strides = a.get("group", 1), a.get("kernel_shape"), a.get("strides")
    pads, extra, dilations = a.get("pads", [0, 0]), a.get("output_padding", [0]), a.get("dilations", [1])
    if (not isinstance(group, int) or group <= 1 or not isinstance(kernel, list) or len(kernel) != 1 or strides != [2]
            or dilations != [1] or not isinstance(pads, list) or len(pads) != 2 or not isinstance(extra, list)
            or len(extra) != 1 or "auto_pad" in a or "output_shape" in a or len(info["inputs"]) not in (2, 3)
            or len(info["outputs"]) != 1):
        return None
    # Transposed conv, stride 2 == interleave a zero after every input step, then an ordinary convolution with the
    # kernel reversed, padded (k-1-pad_begin) in front and (k-1-pad_end+output_padding-1) behind.
    begin, end = kernel[0] - 1 - pads[0], kernel[0] - 1 - pads[1] + extra[0] - 1
    if begin < 0 or end < 0:
        return None
    x, w = info["inputs"][0], info["inputs"][1]
    p = f"/kairos_dml/{tag}"
    return b"".join([
        _constant(p + "/axis3", _tensor_int64([3])),
        _constant(p + "/zero", _tensor_float(0.0)),
        _constant(p + "/shape", _tensor_int64([0, 0, -1])),
        _constant(p + "/starts", _tensor_int64([-1])),
        _constant(p + "/ends", _tensor_int64([-(1 << 63)])),
        _constant(p + "/axis2", _tensor_int64([2])),
        _constant(p + "/steps", _tensor_int64([-1])),
        _node("Unsqueeze", [x, p + "/axis3"], [p + "/u"], p + "/Unsqueeze"),
        _node("Mul", [p + "/u", p + "/zero"], [p + "/z"], p + "/Zeros"),
        _node("Concat", [p + "/u", p + "/z"], [p + "/c"], p + "/Interleave", _attr_int("axis", 3)),
        _node("Reshape", [p + "/c", p + "/shape"], [p + "/stuffed"], p + "/Reshape"),
        _node("Slice", [w, p + "/starts", p + "/ends", p + "/axis2", p + "/steps"], [p + "/reversed"], p + "/Reverse"),
        _node("Conv", [p + "/stuffed", p + "/reversed"] + info["inputs"][2:], info["outputs"], p + "/Conv",
              _attr_int("group", group) + _attr_ints("kernel_shape", kernel) + _attr_ints("pads", [begin, end])
              + _attr_ints("strides", [1]) + _attr_ints("dilations", [1])),
    ])


def dml_compatible_model(data: bytes) -> tuple[bytes, list[str]]:
    """The model with every grouped 1-D stride-2 ConvTranspose replaced (see the module docstring), and the names of
    the layers replaced. A model without one comes back unchanged. ModelProto field 7 is the graph; GraphProto field 1
    is a node."""
    view = memoryview(data)
    pieces, replaced = [], []
    for number, wire, value, whole in _fields(view, 0, len(view)):
        if number != 7 or wire != 2:
            pieces.append(bytes(view[whole[0]:whole[1]]))
            continue
        graph = []
        for n2, w2, v2, whole2 in _fields(view, *value):
            if n2 == 1 and w2 == 2:
                info = _parse_node(view, v2)
                if info["op"] == "ConvTranspose" and info["domain"] in ("", "ai.onnx"):
                    new = _rewrite_conv_transpose(info, str(len(replaced)))
                    if new is not None:
                        graph.append(new)
                        replaced.append(info["name"])
                        continue
            graph.append(bytes(view[whole2[0]:whole2[1]]))
        pieces.append(_len(7, b"".join(graph)))
    if not replaced:
        return data, []
    return b"".join(pieces), replaced
