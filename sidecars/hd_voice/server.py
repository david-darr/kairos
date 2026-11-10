"""Kairos HD voice sidecar: Qwen3-TTS 0.6B on an NVIDIA graphics card, run by core/hd_voice.py as a child process.

It is started with the app's own Python interpreter in isolated mode (-I -S), so nothing from the app's runtime is on
its path: only its own environment (PyTorch with CUDA, Transformers and their dependencies, unpacked by the installer
into the app's data folder) and the reviewed copies of the Qwen3-TTS model code (Apache-2.0) and the CUDA-graph
runner (MIT) in ./vendor (see vendor/NOTICE.md). It never opens a network connection: the model folders were
downloaded and checked by the app, and the Hugging Face libraries are put in offline mode before they load.

Protocol (one GPU, one queue): JSON lines on stdin; framed replies on stdout (4-byte big-endian header length, the
JSON header, then `bytes` raw bytes when the header says so). Anything else the libraries print goes to stderr.
  {"op":"hello"}                          -> {"type":"hello", torch, cuda, device, ...}
  {"op":"load","voice":"iris"}            -> {"type":"loaded", voice, seconds} or {"type":"error"}
  {"op":"say","id":7,"text":..,"voice":..} -> {"id":7,"type":"start","rate":24000}, {"id":7,"type":"audio","bytes":n}+PCM16..., {"id":7,"type":"end"}
  {"op":"cancel","id":7}                  stops that sentence at its next chunk (or before it starts)
  {"op":"quit"}                           exits; so does end of stdin (the app went away)
Sentences render one at a time in arrival order; the app sends the next sentence while one plays, so it is already
queued (prefetched) when the GPU is free.
"""
import json
import os
import queue
import struct
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _arg(name, default=None):
    if name in sys.argv:
        at = sys.argv.index(name)
        if at + 1 < len(sys.argv):
            return sys.argv[at + 1]
    return default


ENV = _arg("--env")
MODELS = _arg("--models")
VOICES = _arg("--voices")

# Only the standard library, our own environment and our vendored code: drop any site-packages that came along.
sys.path[:] = [p for p in sys.path if p and "site-packages" not in p.replace("\\", "/").lower()]
for extra in (os.path.join(HERE, "vendor"), ENV):
    if extra and extra not in sys.path:
        sys.path.insert(0, extra)
for key, value in {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                   "TOKENIZERS_PARALLELISM": "false", "HF_HOME": os.path.join(MODELS or HERE, ".hf-home")}.items():
    os.environ[key] = value

# stdout is the protocol channel: keep a private handle to it and point fd 1 (and print) at stderr.
_proto = os.fdopen(os.dup(1), "wb", buffering=0)
os.dup2(2, 1)
sys.stdout = sys.stderr
# The same for stdin, and fd 0 becomes the null device. On Windows a thread blocked reading fd 0 holds the C runtime's
# lock for it, and loading numpy's or CUDA's DLLs then waits on that lock forever (found 2026-11-10: the import of
# numpy hung while the command reader waited for input). Reading a private copy of the handle avoids it.
_commands = os.fdopen(os.dup(0), "rb", buffering=0)
_null = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null, 0)
os.close(_null)
sys.stdin = open(os.devnull, encoding="utf-8")
_write_lock = threading.Lock()

# Built-in English speakers of the CustomVoice model, and the voices cloned with the Base model from a reference clip
# whose licence allows it (the clip and its transcript live in VOICES, put there by the installer).
SPEAKERS = {"ryan": "ryan", "aiden": "aiden"}
CLONES = {"iris": ("iris.wav", "I consent to my voice being used for voice cloning. Gleason also performed in other "
                                "media. He made the opening day roster.")}
CHUNK_FRAMES = 4                    # 12.5 codec frames a second: about 0.33 s of audio per streamed piece
MAX_TEXT = 1600


def send(header, payload=b""):
    if payload:
        header = {**header, "bytes": len(payload)}
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    with _write_lock:
        _proto.write(struct.pack(">I", len(raw)) + raw + payload)


def cap(text):
    """Frames allowed for a sentence: about 2.5 times a normal speaking length, so a runaway stops (bake-off)."""
    return int(25 + 2.0 * len(text))


class Engine:
    def __init__(self):
        self.kind = None                # "customvoice" or "base"
        self.tts = None
        self.cancelled = set()

    def _kind(self, voice):
        if voice in CLONES:
            return "base"
        if voice in SPEAKERS:
            return "customvoice"
        raise ValueError(f"Unknown HD voice: {voice}")

    def load(self, voice):
        import torch
        kind = self._kind(voice)
        if self.kind == kind and self.tts is not None:
            return 0.0
        started = time.perf_counter()
        if self.tts is not None:
            self.tts = None
            self.kind = None
            torch.cuda.empty_cache()
        from qwen_fast import FasterQwen3TTS
        tts = FasterQwen3TTS.from_pretrained(os.path.join(MODELS, kind), device="cuda", dtype=torch.bfloat16,
                                             attn_implementation="sdpa", local_files_only=True)
        tts.warmup()
        self.tts, self.kind = tts, kind
        # One short render so the first real sentence does not pay first-run kernel set-up.
        for _ in self._stream("Okay.", voice):
            pass
        return time.perf_counter() - started

    def _stream(self, text, voice):
        if voice in CLONES:
            name, transcript = CLONES[voice]
            return self.tts.generate_voice_clone_streaming(
                text=text, language="English", ref_audio=os.path.join(VOICES, name), ref_text=transcript,
                chunk_size=CHUNK_FRAMES, max_new_tokens=cap(text))
        return self.tts.generate_custom_voice_streaming(
            text=text, speaker=SPEAKERS[voice], language="English", chunk_size=CHUNK_FRAMES, max_new_tokens=cap(text))

    def say(self, ident, text, voice):
        import numpy as np
        if ident in self.cancelled:
            self.cancelled.discard(ident)
            send({"id": ident, "type": "end", "cancelled": True})
            return
        if not text.strip() or len(text) > MAX_TEXT:
            raise ValueError("That text cannot be spoken.")
        self.load(voice)
        send({"id": ident, "type": "start", "rate": 24000})
        pieces = self._stream(text, voice)
        try:
            for audio, rate, _timing in pieces:
                if ident in self.cancelled:
                    break
                samples = np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1.0, 1.0)
                if samples.size:
                    send({"id": ident, "type": "audio"}, (samples * 32767.0).astype("<i2").tobytes())
        finally:
            close = getattr(pieces, "close", None)
            if close:
                close()
        cancelled = ident in self.cancelled
        self.cancelled.discard(ident)
        send({"id": ident, "type": "end", **({"cancelled": True} if cancelled else {})})


def hello():
    import torch
    info = {"type": "hello", "torch": torch.__version__, "cuda": bool(torch.cuda.is_available())}
    if info["cuda"]:
        info.update(device=torch.cuda.get_device_name(0), cuda_version=torch.version.cuda,
                    capability=".".join(str(x) for x in torch.cuda.get_device_capability(0)))
    return info


def main():
    engine = Engine()
    jobs = queue.Queue()

    def reader():
        for line in _commands:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("op") == "cancel":
                engine.cancelled.add(message.get("id"))
                continue
            jobs.put(message)
            if message.get("op") == "quit":
                return
        jobs.put({"op": "quit"})

    threading.Thread(target=reader, daemon=True).start()
    while True:
        message = jobs.get()
        op, ident = message.get("op"), message.get("id")
        try:
            if op == "quit":
                break
            if op == "hello":
                send(hello())
            elif op == "load":
                send({"type": "loaded", "voice": message.get("voice"), "seconds": round(engine.load(str(message.get("voice"))), 2)})
            elif op == "say":
                engine.say(ident, str(message.get("text") or ""), str(message.get("voice") or ""))
        except Exception as error:      # reported, never fatal: the app falls back to Kokoro for this sentence
            text = (str(error).strip().splitlines() or [type(error).__name__])[0][:300]
            print(f"hd voice: {op} failed: {type(error).__name__}: {text}", file=sys.stderr, flush=True)
            send({"id": ident, "type": "error", "op": op, "message": text})
    if os.environ.get("KAIROS_HD_MODULES"):    # development: which packages a real run imported (to trim the lock)
        with open(os.environ["KAIROS_HD_MODULES"], "w", encoding="utf-8") as handle:
            handle.write("\n".join(sorted({name.split(".")[0] for name in sys.modules})))
    sys.stderr.flush()


if __name__ == "__main__":
    main()
