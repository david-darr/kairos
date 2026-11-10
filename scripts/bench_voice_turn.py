"""End-to-end voice turn benchmark: real speech audio in, p50/p95 latencies out.

    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py              full run: GPU and CPU, real whisper and OS voice
    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py --backend cuda --repeats 5
    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py --light      CI-light: fakes for speech-to-text and the voice
    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py --backend cuda --smart-turn real --voice-engine both
    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py --backend none --kokoro-bench 10    Kokoro on its own
    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py --backend none --kokoro-bench 10 --kokoro-gap 4   plus idle gaps
    ... --voice-engine kokoro --kokoro-provider CPU      pin Kokoro's provider in the turns (default: what the app picks)
    ... --voice-engine hd --hd-voice iris                HD voice (Qwen3-TTS on an NVIDIA card, core/hd_voice.py), read
                                                         from --hd-dir (default: this checkout's data\\speech_models\\hd_voice)

The optional ONNX models (Smart Turn, Kokoro) are read, never written, from --onnx-dir: by default the `onnx` folder
beside the whisper model (--models-dir), else the dev profile's speech_models\\onnx. They run through the app's own
core/turn_detect.py and core/kokoro_voice.py, exactly as the app runs them.

What runs for real (full mode)
  speech audio     fixture WAVs rendered offline by the OS voice (Windows SAPI), 16 kHz, with a lead-in, a mid-sentence
                   pause in one of them, and a tail of quiet; plus a faint noise floor
  capture/endpoint the app's own static/js/speechSegments.js SpeechSegments, fed 10 ms blocks at real-time pace
  rolling partials the app's own static/js/partialTranscript.js, against the same engine as the call
  speech-to-text   core/speech.py transcribe_call: pywhispercpp on CPU, or the whisper.cpp CUDA server (core/speech_acceleration)
  turn             a scripted stand-in model (no cloud call): first token after --ttft ms, then --tokens-per-s
  sentences        the app's own createChunker (first clause / first sentence release, 100 ms flush)
  acknowledgement  the app's own createFillerGate (the half-second rule)
  end of turn      --smart-turn real: the app's static/js/turnEndpoint.js (700 ms ask timeout) posting the utterance so far to
                   core/turn_detect.py with the real Smart Turn model; oracle: a perfect verdict after 15 ms; off: silence only
  voice            Windows SAPI; "first audio" is the moment the engine first writes audio, plus the 25 ms scheduling lead.
                   --voice-engine kokoro: core/kokoro_voice.synthesize (the whole sentence is rendered before the first
                   100 ms piece goes out, as core/call_voices.py does), so its first audio is the sentence's render time
                   --voice-engine hd: core/hd_voice.stream (the sidecar streams each sentence; first audio is the first
                   trimmed piece, so the model's leading silence is not counted as sound)
  barge-in         the app's own BargeIn fed the user's voice over an attenuated copy of the reply (the echo canceller's residue)

What is modelled, not measured: the language model (a scripted stand-in), the browser's audio output buffer (20 ms added to
the barge-in stop), and the speechSynthesis/Web Audio hop in Chromium. Everything is reported from the end of the user's speech.
In --light mode speech-to-text and the voice are fakes with fixed delays and the audio is synthetic; it checks the plumbing
and the arithmetic, and is what the unit test runs.
"""
import argparse
import base64
import http.server
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
RATE = 16000
OUTPUT_BUFFER_MS = 20          # the browser's audio output buffer, added to the barge-in stop (modelled)
WORKLET_BLOCK_MS = 8           # the worklet decides on 128-sample blocks (at 16 kHz)
REPLY = "Sure thing. I checked and you have two meetings this afternoon, one at two and one at four. Want me to read them out?"

# (name, text). One has a pause inside the sentence; one is long.
SPEECH = [
    ("short", "What's on my calendar this afternoon?"),
    ("medium", "Can you remind me to call my sister tomorrow morning before lunch?"),
    ("long", "I was wondering whether you could look at the budget spreadsheet I sent over yesterday and tell me if the travel numbers look right."),
    ("pause", ["I was thinking about the trip", 0.6, "to Denver next month, and whether we should book flights this week."]),
    # Diagnostic: a pause longer than the 700 ms silence wait splits the turn without Smart Turn. Counted, not timed.
    ("pause_long", ["I was thinking about the trip", 1.0, "to Denver next month."]),
]
DIAGNOSTIC = {"pause_long"}
BARGE = [("interrupt", "Actually can you say that again please?"), ("nod", "Yeah.")]
FILLER_TEXT = "Okay."


def say(message):
    print(message, file=sys.stderr, flush=True)


def percentile(values, q):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    position = (len(values) - 1) * q
    low, high = math.floor(position), math.ceil(position)
    return values[low] + (values[high] - values[low]) * (position - low)


def wer(reference, hypothesis):
    words = lambda text: re.sub(r"[^a-z0-9' ]+", " ", str(text).lower()).split()   # noqa: E731
    ref, hyp = words(reference), words(hypothesis)
    if not ref:
        return 0.0
    table = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        previous, table[0] = table[0], i
        for j, h in enumerate(hyp, 1):
            previous, table[j] = table[j], min(table[j] + 1, table[j - 1] + 1, previous + (r != h))
    return table[len(hyp)] / len(ref)


# -- audio fixtures ------------------------------------------------------------------------------------------------------

def write_wav(path, samples):
    import numpy as np
    data = np.clip(np.asarray(samples, dtype=np.float32), -1, 1)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(RATE)
        handle.writeframes((data * 32767).astype("<i2").tobytes())


def pcm_to_float(raw):
    import numpy as np
    return np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2").astype(np.float32) / 32768


def edges(samples, level=0.01):
    """(first, last) sample index where 10 ms of audio is louder than `level` RMS."""
    import numpy as np
    block = 160
    count = len(samples) // block
    if not count:
        return 0, 0
    rms = np.sqrt((np.asarray(samples[: count * block]).reshape(count, block) ** 2).mean(axis=1))
    loud = np.nonzero(rms > level)[0]
    if not len(loud):
        return 0, 0
    return int(loud[0] * block), int((loud[-1] + 1) * block)


def with_floor(samples, seed):
    import numpy as np
    noise = np.random.default_rng(seed).normal(0, 0.0015, len(samples)).astype(np.float32)
    return samples + noise


def synthetic_speech(ms, volume=0.05):
    """Speech-like audio for CI-light: two formants with a syllable-rate swell (energy VAD sees it as speech)."""
    import numpy as np
    t = np.arange(int(RATE * ms / 1000)) / RATE
    swell = 0.6 + 0.4 * np.sin(2 * np.pi * 4 * t) ** 2
    return (volume * swell * (np.sin(2 * np.pi * 310 * t) + 0.5 * np.sin(2 * np.pi * 870 * t))).astype(np.float32)


def build_fixtures(workdir, render=None):
    """Write the fixture WAVs and return the config entries. `render(text)` -> float32 samples (SAPI), or None for synthetic."""
    import numpy as np
    workdir.mkdir(parents=True, exist_ok=True)
    fixtures, barge = [], []
    quiet = lambda seconds: np.zeros(int(RATE * seconds), dtype=np.float32)   # noqa: E731
    for index, (name, spec) in enumerate(SPEECH):
        pieces = [spec] if isinstance(spec, str) else spec
        parts, words = [], []
        for piece in pieces:
            if isinstance(piece, (int, float)):
                parts.append(quiet(piece))
            else:
                spoken = render(piece) if render else synthetic_speech(900 + 12 * len(piece) * 5)
                first, last = edges(spoken, 0.01)
                parts.append(spoken[max(0, first - 320): last + 320] if last > first else spoken)   # the voice's own padding out
                words.append(piece)
        speech = np.concatenate(parts)
        audio = with_floor(np.concatenate([quiet(0.6), speech, quiet(2.2)]), 11 + index)
        _first, last = edges(audio)
        path = workdir / f"{name}.wav"
        write_wav(path, audio)
        fixtures.append({"name": name, "wav": str(path), "speech_end_sample": last, "text": " ".join(words), "diagnostic": name in DIAGNOSTIC})
    for index, (name, text) in enumerate(BARGE):
        samples = render(text) if render else synthetic_speech(1500 if name == "interrupt" else 190, 0.12)
        audio = with_floor(samples, 91 + index)
        first, _last = edges(audio, 0.01)
        path = workdir / f"barge-{name}.wav"
        write_wav(path, audio)
        barge.append({"name": name, "wav": str(path), "onset_sample": first})
    return fixtures, barge


# -- the services the Node harness calls -------------------------------------------------------------------------------

class SapiWorker:
    """Windows SAPI in a long-lived PowerShell child (scripts/bench_sapi_worker.ps1)."""

    def __init__(self, voice="Microsoft Zira Desktop"):
        self.voice, self.lock, self.count = voice, threading.Lock(), 0
        self.process = subprocess.Popen(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPTS / "bench_sapi_worker.ps1")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
        line = self.process.stdout.readline()
        if '"ready"' not in line:
            raise RuntimeError("the SAPI renderer did not start: " + line)

    def render(self, text):
        with self.lock:
            self.count += 1
            self.process.stdin.write(json.dumps({"id": self.count, "text": text, "voice": self.voice, "rate": 0}) + "\n")
            self.process.stdin.flush()
            answer = json.loads(self.process.stdout.readline())
        raw = base64.b64decode(answer["audio"])
        return {"first_write_ms": float(answer["first_write_ms"]), "total_ms": float(answer["total_ms"]), "raw": raw}

    def samples(self, text):
        return pcm_to_float(self.render(text)["raw"])

    def close(self):
        try:
            self.process.stdin.close(); self.process.terminate()
        except Exception:
            pass


def resample(samples, rate_in, rate_out=RATE):
    import numpy as np
    samples = np.asarray(samples, dtype=np.float32)
    if rate_in == rate_out or not len(samples):
        return samples
    count = int(round(len(samples) * rate_out / rate_in))
    return np.interp(np.arange(count) * (rate_in / rate_out), np.arange(len(samples)), samples).astype(np.float32)


def hd_render(text, voice="iris"):
    """One sentence through the app's HD path: the spoken-text clean-up, then core/hd_voice.stream (sidecar, edge trim).
    -> (ms to the first audio piece, total ms, 24 kHz PCM16 bytes). Raises if HD could not speak it (the app would
    have used Kokoro: a bench must not hide that)."""
    import asyncio
    from core import hd_voice, voice_style

    async def go():
        started, first, pcm = time.perf_counter(), None, bytearray()
        async for item in hd_voice.stream(voice_style.strip_for_speech(text), voice):
            if "audio" in item:
                first = first if first is not None else (time.perf_counter() - started) * 1000
                pcm += item["audio"]
        return first, (time.perf_counter() - started) * 1000, bytes(pcm)
    return asyncio.run(go())


def kokoro_render(text, voice="default"):
    """One sentence through the app's Kokoro path: the spoken-text clean-up, then core/kokoro_voice.synthesize.
    -> (render ms, 24 kHz PCM16 bytes)."""
    from core import kokoro_voice, voice_style
    started = time.perf_counter()
    pcm = kokoro_voice.synthesize(voice_style.strip_for_speech(text), voice)
    return (time.perf_counter() - started) * 1000, pcm


class FakeTurnSession:
    """CI-light stand-in for the Smart Turn onnx session: real features in, a fixed probability out."""

    class _Input:
        name = "input_features"

    def __init__(self, probability=0.9, delay_ms=10):
        self.probability, self.delay_ms = probability, delay_ms

    def get_inputs(self):
        return [self._Input()]

    def run(self, _outputs, feeds):
        import numpy as np
        assert feeds["input_features"].shape == (1, 80, 800)
        time.sleep(self.delay_ms / 1000)
        return [np.array([[self.probability]], dtype=np.float32)]


class FakeKokoro:
    """CI-light stand-in for kokoro_onnx.Kokoro: a fixed render delay, speech-like 24 kHz audio."""

    def __init__(self, delay_ms=50):
        self.delay_ms = delay_ms

    def get_voices(self):
        return ["af_heart"]

    def create(self, text, voice, speed, lang):
        time.sleep(self.delay_ms / 1000)
        return resample(synthetic_speech(60 * max(1, len(text)), 0.1), RATE, 24000), 24000


def use_onnx_dir(folder):
    """Point the app's optional-model lookups at `folder` (read only). Returns the previous folder."""
    from core import kokoro_voice, speech_optional, turn_detect
    previous = speech_optional.OPTIONAL_DIR
    speech_optional.OPTIONAL_DIR = str(folder)
    turn_detect.reset(); kokoro_voice.reset()
    return previous


class Services:
    """STT, TTS and the end-of-turn model over loopback HTTP. Real (whisper, SAPI or Kokoro, Smart Turn) or fake (CI-light)."""

    def __init__(self, light, backend, model, sapi=None, texts=None, light_stt_ms=150, light_tts_ms=50, voice_engine="sapi", kokoro_voice_name="default", hd_voice_name="iris"):
        self.light, self.backend, self.model, self.sapi = light, backend, model, sapi
        self.texts = texts or {}
        self.light_stt_ms, self.light_tts_ms = light_stt_ms, light_tts_ms
        self.voice_engine, self.kokoro_voice_name, self.hd_voice_name = voice_engine, kokoro_voice_name, hd_voice_name
        self.hd_first = []
        self.calls = {"final": 0, "partial": 0, "tts": 0, "turn": 0}
        self.turn_ms = []          # Smart Turn's own time per verdict, inside the service (the rest is transport and waiting)
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                try:
                    answer = owner.handle(self.path, body, self.headers.get("x-fixture", ""))
                    payload = json.dumps(answer).encode()
                    self.send_response(200)
                except Exception as error:   # noqa: BLE001
                    payload = json.dumps({"error": str(error)}).encode()
                    self.send_response(500)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except ConnectionError:
                    pass                  # the caller gave up (the turn endpoint's 700 ms ask timeout): not an error here

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def handle(self, path, body, fixture):
        started = time.perf_counter()
        if path == "/turn":
            # What routes/speech_routes.py end_of_turn answers, from the same core/turn_detect.predict.
            self.calls["turn"] += 1
            from core import turn_detect
            try:
                verdict = turn_detect.predict(body)
                self.turn_ms.append((time.perf_counter() - started) * 1000)
                return {"available": True, **verdict}
            except turn_detect.TurnUnavailable as error:
                return {"available": False, "complete": True, "probability": None, "reason": str(error)}
        if path == "/tts":
            self.calls["tts"] += 1
            text = json.loads(body)["text"]
            if self.voice_engine == "hd":
                first_ms, total_ms, pcm = hd_render(text, self.hd_voice_name)
                self.hd_first.append(first_ms)
                audio = resample(pcm_to_float(pcm), 24000)          # the harness's echo model works at 16 kHz
                return {"first_write_ms": first_ms, "total_ms": total_ms, "audio_ms": round(len(audio) / 16),
                        "audio": base64.b64encode((audio * 32767).astype("<i2").tobytes()).decode()}
            if self.voice_engine == "kokoro":
                render_ms, pcm = kokoro_render(text, self.kokoro_voice_name)
                audio = resample(pcm_to_float(pcm), 24000)          # the harness's echo model works at 16 kHz
                return {"first_write_ms": render_ms, "total_ms": render_ms, "audio_ms": round(len(audio) / 16),
                        "audio": base64.b64encode((audio * 32767).astype("<i2").tobytes()).decode()}
            if self.light:
                time.sleep(self.light_tts_ms / 1000)
                audio = synthetic_speech(1800, 0.1)
                return {"first_write_ms": self.light_tts_ms, "total_ms": self.light_tts_ms + 5, "audio_ms": 1800,
                        "audio": base64.b64encode((audio * 32767).astype("<i2").tobytes()).decode()}
            answer = self.sapi.render(text)
            return {"first_write_ms": answer["first_write_ms"], "total_ms": answer["total_ms"], "audio_ms": round(len(answer["raw"]) / 2 / 16),
                    "audio": base64.b64encode(answer["raw"]).decode()}
        partial = path == "/stt/partial"
        self.calls["partial" if partial else "final"] += 1
        if self.light:
            time.sleep((self.light_stt_ms * (0.6 if partial else 1)) / 1000)
            text = self.texts.get(fixture, "hello there")
            reply = {"text": text, "engine": "cuda", "timings": {"recognition_ms": self.light_stt_ms}}
            if partial:
                reply["segments"] = [{"text": text, "start_ms": 0, "end_ms": 1000}]
            return reply
        from core import speech
        result = speech.transcribe_call(body, self.model, "auto" if self.backend == "cuda" else "cpu", segments=partial, blocking=not partial)
        result["timings"] = {"recognition_ms": round((time.perf_counter() - started) * 1000)}
        return result

    def close(self):
        self.server.shutdown(); self.server.server_close()


# -- running -----------------------------------------------------------------------------------------------------------

def find_node():
    return shutil.which("node") or shutil.which("node.exe")


def run_harness(config, workdir):
    path = Path(workdir) / "config.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    run = subprocess.run([find_node(), str(SCRIPTS / "bench_voice_harness.mjs"), str(path)], capture_output=True, text=True, encoding="utf-8", timeout=1800)
    if run.returncode != 0:
        raise RuntimeError("the harness failed:\n" + run.stderr[-3000:])
    return json.loads(run.stdout)


def summarize(result, fixtures, label):
    texts = {f["name"]: f["text"] for f in fixtures}
    diagnostic = [t for t in result["turns"] if t["fixture"] in DIAGNOSTIC]
    turns = [t for t in result["turns"] if not t.get("failed") and t["fixture"] not in DIAGNOSTIC]
    metrics = ["endpoint_ms", "stt_ms", "transcript_final_ms", "first_token_ms", "first_sentence_ms", "first_audio_ms", "first_sound_ms"]
    summary = {"label": label, "turns": len(turns), "failed": sum(1 for t in result["turns"] if t.get("failed") and t["fixture"] not in DIAGNOSTIC),
               "splits": sum(1 for t in turns if t.get("segments", 1) > 1),
               "long_pause_splits": sum(1 for t in diagnostic if t.get("segments", 1) > 1), "long_pause_n": len(diagnostic)}
    # A turn that split (the endpoint fired mid-sentence) was answered from its first part: its times, anchored to the
    # last endpoint, are not a latency. It is counted in `splits` (and Smart Turn's false cut-offs) instead.
    whole = [t for t in turns if t.get("segments", 1) <= 1]
    summary["timed"] = len(whole)
    for metric in metrics:
        values = [t.get(metric) for t in whole]
        summary[metric] = {"p50": percentile(values, 0.5), "p95": percentile(values, 0.95), "n": sum(v is not None for v in values)}
    fillers = [t for t in turns if t.get("filler_ms") is not None]
    summary["filler"] = {"turns": len(fillers), "p50": percentile([t["filler_ms"] for t in fillers], 0.5),
                         "after_filler_p50": percentile([t.get("first_audio_after_filler_ms") for t in fillers], 0.5)}
    summary["wer"] = statistics.mean(wer(texts.get(t["fixture"], ""), t.get("transcript", "")) for t in turns) if turns else None
    summary["stt_modes"] = {mode: sum(1 for t in turns if t.get("stt_mode") == mode) for mode in sorted({t.get("stt_mode") for t in turns if t.get("stt_mode")})}
    summary["by_fixture"] = {}
    for name in [n for n in texts if n not in DIAGNOSTIC]:
        mine = [t for t in whole if t["fixture"] == name]
        summary["by_fixture"][name] = {"first_audio_p50": percentile([t.get("first_audio_ms") for t in mine], 0.5), "stt_p50": percentile([t.get("stt_ms") for t in mine], 0.5), "audio_ms": mine[0]["audio_ms"] if mine else None}
    barges = result["barges"]
    interrupt = [b for b in barges if b["fixture"] == "interrupt"]
    nod = [b for b in barges if b["fixture"] == "nod"]
    stop = [b["duck_ms"] + WORKLET_BLOCK_MS + OUTPUT_BUFFER_MS for b in interrupt if b["duck_ms"] is not None]
    summary["voice_render"] = {"p50": percentile([t.get("tts_first_write_ms") for t in turns], 0.5), "p95": percentile([t.get("tts_first_write_ms") for t in turns], 0.95)}
    smart = [t for t in result["turns"] if t.get("smart")]
    if smart:
        cut = lambda name: [t for t in result["turns"] if t["fixture"] == name]   # noqa: E731
        summary["smart"] = {
            "asks": sum(t["smart"]["asks"] for t in smart), "no_verdict": sum(t["smart"]["none"] for t in smart),
            "complete": sum(t["smart"]["complete"] for t in smart), "incomplete": sum(t["smart"]["incomplete"] for t in smart),
            "verdict_p50": percentile([v for t in smart for v in t["smart"]["verdict_ms"]], 0.5),
            "verdict_p95": percentile([v for t in smart for v in t["smart"]["verdict_ms"]], 0.95),
            # A false cut-off: Smart Turn said "finished" while the speaker was only pausing, so the turn split.
            "false_cutoffs": {name: {"turns": sum(1 for t in cut(name) if t.get("segments", 1) > 1), "n": len(cut(name))} for name in ("pause", "pause_long")},
            "early_complete": sum(t["smart"]["early_complete"] for t in smart),
            "by_fixture": {name: [p for t in cut(name) if t.get("smart") for p in t["smart"]["probabilities"]] for name in texts},
        }
    summary["barge"] = {
        "stop_p50": percentile(stop, 0.5), "stop_p95": percentile(stop, 0.95),
        "detect_p50": percentile([b["duck_ms"] for b in interrupt if b["duck_ms"] is not None], 0.5),
        "commit_p50": percentile([b["barge_ms"] for b in interrupt if b["barge_ms"] is not None], 0.5),
        "interrupts_heard": sum(1 for b in interrupt if b["outcome"] == "interrupt"), "interrupt_n": len(interrupt),
        "nods_ignored": sum(1 for b in nod if b["outcome"] == "nod"), "nod_n": len(nod),
        "nods_that_cut": sum(1 for b in nod if b["outcome"] == "interrupt"),
    }
    return summary


def fmt(value):
    return "-" if value is None else f"{value:.0f}"


def table(summaries, meta):
    rows = [("endpoint decided", "endpoint_ms"), ("transcript final", "transcript_final_ms"), ("first token", "first_token_ms"),
            ("first sentence ready", "first_sentence_ms"), ("first audio (the answer)", "first_audio_ms"), ("first sound (ack or answer)", "first_sound_ms")]
    width, col = 42, 17
    cell = lambda a, b: f"{fmt(a)} / {fmt(b)}"   # noqa: E731
    lines = [f"Voice turn benchmark: {meta}", "", "all numbers: milliseconds after the user stops speaking, p50 / p95"]
    header = f"{'':<{width}}" + "".join(f"{s['label']:>{col}}" for s in summaries)
    lines += [header, "-" * len(header)]
    for name, key in rows:
        lines.append(f"{name:<{width}}" + "".join(f"{cell(s[key]['p50'], s[key]['p95']):>{col}}" for s in summaries))
    lines.append(f"{'  of which speech-to-text after endpoint':<{width}}" + "".join(f"{cell(s['stt_ms']['p50'], s['stt_ms']['p95']):>{col}}" for s in summaries))
    lines.append(f"{'barge-in: voice starts to audio stops':<{width}}" + "".join(f"{cell(s['barge']['stop_p50'], s['barge']['stop_p95']):>{col}}" for s in summaries))
    lines.append(f"{'barge-in: voice starts to reply cancelled':<{width}}" + "".join(f"{fmt(s['barge']['commit_p50']):>{col}}" for s in summaries))
    lines.append("")
    for s in summaries:
        lines.append(f"{s['label']}: {s['turns']} turns, {s['timed']} timed ({s['failed']} failed; split by the 0.6 s mid-sentence pause {s['splits']}; a 1.0 s pause split {s['long_pause_splits']}/{s['long_pause_n']}), "
                     f"word error {0 if s['wer'] is None else s['wer'] * 100:.0f}%, final pass {s['stt_modes']}, acknowledgement on {s['filler']['turns']} turns "
                     f"(first sound p50 {fmt(s['filler']['p50'])} ms, answer behind it p50 {fmt(s['filler']['after_filler_p50'])} ms), "
                     f"interrupts heard {s['barge']['interrupts_heard']}/{s['barge']['interrupt_n']}, nods ignored {s['barge']['nods_ignored']}/{s['barge']['nod_n']}")
    lines.append("")
    lines.append("by fixture, first audio p50 / speech-to-text p50 (ms): " + "; ".join(
        f"{s['label']}: " + ", ".join(f"{name} {fmt(v['first_audio_p50'])}/{fmt(v['stt_p50'])}" for name, v in s["by_fixture"].items()) for s in summaries))
    lines.append("voice render p50 / p95 (ms, the engine's time to the first audio of the first sentence): " + "; ".join(
        f"{s['label']} {fmt(s['voice_render']['p50'])}/{fmt(s['voice_render']['p95'])}" for s in summaries))
    for s in summaries:
        if s.get("smart"):
            m = s["smart"]
            cuts = ", ".join(f"{name} {v['turns']}/{v['n']}" for name, v in m["false_cutoffs"].items())
            lines.append(f"{s['label']}: Smart Turn asked {m['asks']} times, verdict p50/p95 {fmt(m['verdict_p50'])}/{fmt(m['verdict_p95'])} ms, "
                         f"(of which the model {fmt(m.get('model_p50'))}/{fmt(m.get('model_p95'))} ms), {m['complete']} finished / {m['incomplete']} not yet / {m['no_verdict']} no answer in time; "
                         f"false cut-offs (turn split at a mid-sentence pause): {cuts}; said finished before the speaker was: {m['early_complete']}")
    if any("SmartTurn*" in s["label"] for s in summaries):
        lines.append("* SmartTurn*: a perfect verdict after 15 ms (the upper bound for any turn model).")
    lines.append("Barge-in stop adds an 8 ms worklet block and a modelled 20 ms output buffer.")
    return "\n".join(lines)


def light_pace(args, smart):
    """Full runs feed audio in real time. CI-light runs as fast as it can, except with a turn model in the loop: its
    verdict takes wall-clock time, so the audio runs at 4x real time to leave the verdict room before the silence wait."""
    if not args.light or args.realtime:
        return 1
    return 4 if smart == "real" else 0


def harness_config(services, fixtures, barge, backend, args, filler, ttft=None, smart=""):
    return {"service_url": services.url, "fixtures": fixtures, "barge": barge, "repeats": args.repeats, "barge_repeats": args.barge_repeats,
            "backend": backend, "partials": backend == "cuda", "pace": light_pace(args, smart), "silence_ms": 700,
            "ttft_ms": args.ttft if ttft is None else ttft, "tokens_per_s": args.tokens_per_s, "reply": REPLY, "leak_gain": args.leak_gain,
            "filler_clip": filler is not None, "filler_ms": filler or 0, "smart_turn": smart or "", "smart_ms": 15}


def dev_profile():
    return Path(os.environ.get("APPDATA", "")) / "JARVIS-dev" / "data"


def detect_models_dir():
    for candidate in (os.environ.get("KAIROS_BENCH_MODELS"), r"C:\Users\David\ai-servers\whisper.cpp\models", str(dev_profile() / "speech_models")):
        if candidate and (Path(candidate) / "ggml-small.en.bin").is_file():
            return candidate
    return None


def detect_onnx_dir(models_dir=None):
    """The optional models' folder: beside the whisper model, else the dev profile's (where the app's download puts them)."""
    for candidate in ((Path(models_dir) / "onnx") if models_dir else None, dev_profile() / "speech_models" / "onnx"):
        if candidate and candidate.is_dir():
            return str(candidate)
    return None


def detect_runtime():
    """The whisper.cpp CUDA folder: as the app finds it (the dev profile's speech_runtime.json, core/speech_acceleration),
    else the known install folder."""
    registered = None
    try:
        registered = json.loads((dev_profile() / "speech_runtime.json").read_text(encoding="utf-8")).get("folder")
    except (OSError, ValueError, AttributeError):
        pass
    for candidate in (os.environ.get("KAIROS_BENCH_WHISPER_RUNTIME"), registered, r"C:\Users\David\ai-servers\whisper.cpp\Release"):
        if candidate and (Path(candidate) / "whisper-server.exe").is_file() and (Path(candidate) / "ggml-cuda.dll").is_file():
            return candidate
    return None


def warm_models(smart, kokoro, hd=None):
    """What a call start does (routes/speech_routes.py prepare): load the optional models and run them once, so the
    first turn does not pay the load. Returns {name: ms}."""
    from core import kokoro_voice, turn_detect
    spent = {}
    if hd:
        import asyncio
        from core import hd_voice
        started = time.perf_counter()
        if not asyncio.run(hd_voice.warm(hd)):
            raise SystemExit("HD voice could not load: " + " | ".join(list(hd_voice._sidecar.stderr)[-3:]))
        spent["hd_warm_ms"] = round((time.perf_counter() - started) * 1000)
    if smart:
        started = time.perf_counter(); turn_detect.warm(); spent["smart_turn_warm_ms"] = round((time.perf_counter() - started) * 1000)
    if kokoro:
        started = time.perf_counter(); kokoro_voice.warm(); spent["kokoro_warm_ms"] = round((time.perf_counter() - started) * 1000)
    return spent


# The reply's sentences as the chunker hands them to the voice (first clause first).
KOKORO_SENTENCES = ["Sure thing.", "I checked and you have two meetings this afternoon, one at two and one at four.", "Want me to read them out?"]
PROVIDERS = [("CPU", "CPUExecutionProvider"), ("DirectML", "DmlExecutionProvider"), ("CUDA", "CUDAExecutionProvider")]


GAPS_S = (2, 5, 8)      # idle gaps before a render: renders after a few seconds idle were erratic on the CPU (2026-11-07)


def kokoro_bench(repeats, voice="default", gaps=0):
    """Kokoro on its own, per execution provider, through the app's own provider choice (core/onnx_providers.py, pinned
    with kokoro_voice.FORCE_PROVIDER): cold start, then time to first audio per sentence (the whole sentence is rendered
    before its first piece is sent, so that is the render time), then with `gaps` > 0, "Sure thing." rendered `gaps`
    times after each idle gap in GAPS_S. Providers this onnxruntime build lacks are reported, not installed."""
    import onnxruntime
    from core import kokoro_voice
    available = onnxruntime.get_available_providers()
    results, previous = [], kokoro_voice.FORCE_PROVIDER
    try:
        for label, provider in PROVIDERS:
            if provider not in available:
                results.append({"provider": label, "available": False}); continue
            kokoro_voice.FORCE_PROVIDER = provider
            kokoro_voice.reset()
            started = time.perf_counter(); engine = kokoro_voice._get_engine(); load_ms = (time.perf_counter() - started) * 1000
            first_ms, _ = kokoro_render(KOKORO_SENTENCES[0], voice)
            rows = []
            for sentence in KOKORO_SENTENCES:
                times, audio_ms = [], 0
                for _ in range(repeats):
                    spent, pcm = kokoro_render(sentence, voice)
                    times.append(spent); audio_ms = len(pcm) / 48
                rows.append({"sentence": sentence, "p50": percentile(times, 0.5), "p95": percentile(times, 0.95), "audio_ms": audio_ms,
                             "realtime": audio_ms / max(1e-6, percentile(times, 0.5))})
            idle = []
            for gap in (GAPS_S if gaps else ()):
                times = []
                for _ in range(gaps):
                    time.sleep(gap)
                    times.append(kokoro_render(KOKORO_SENTENCES[0], voice)[0])
                idle.append({"gap_s": gap, "times": times, "p50": percentile(times, 0.5), "max": max(times)})
            results.append({"provider": label, "available": True, "session": list(engine.sess.get_providers()) if hasattr(engine, "sess") else [],
                            "load_ms": load_ms, "first_render_ms": first_ms, "sentences": rows, "idle": idle})
    finally:
        kokoro_voice.FORCE_PROVIDER = previous
        kokoro_voice.reset()
    return results


def kokoro_table(results, repeats):
    lines = ["", f"Kokoro on its own ({repeats} renders per sentence; first audio = the sentence's render time, ms p50 / p95)"]
    for row in results:
        if not row["available"]:
            lines.append(f"  {row['provider']}: not in this onnxruntime build (it has {', '.join(__import__('onnxruntime').get_available_providers())})")
            continue
        lines.append(f"  {row['provider']} ({', '.join(row['session'])}): model load {fmt(row['load_ms'])}, first render after load {fmt(row['first_render_ms'])}")
        for s in row["sentences"]:
            lines.append(f"    {fmt(s['p50'])} / {fmt(s['p95'])} for {fmt(s['audio_ms'])} ms of audio ({s['realtime']:.1f}x real time): {s['sentence']}")
        for gap in row.get("idle") or []:
            lines.append(f"    after {gap['gap_s']} s idle, '{KOKORO_SENTENCES[0]}': p50 {fmt(gap['p50'])}, worst {fmt(gap['max'])} ({', '.join(fmt(t) for t in gap['times'])})")
    return "\n".join(lines)


def scenario_list(args):
    """(label, backend, ttft, smart turn mode, voice engine) for the full run."""
    smart_modes = {"off": [], "oracle": ["oracle"], "real": ["real"], "all": ["oracle", "real"]}[args.smart_turn]
    engines = ["sapi", "kokoro"] if args.voice_engine == "both" else [args.voice_engine]
    tag = lambda engine: {"sapi": "", "kokoro": "+Kokoro", "hd": "+HD"}[engine]   # noqa: E731
    out = []
    if args.backend in ("cuda", "both"):
        for engine in engines:
            out.append((f"GPU{tag(engine)}", "cuda", args.ttft, "", engine))
            for mode in smart_modes:
                out.append((f"GPU+SmartTurn{'*' if mode == 'oracle' else ''}{tag(engine)}", "cuda", args.ttft, mode, engine))
        if args.ttft_slow:
            out.append((f"GPU slow {args.ttft_slow}", "cuda", args.ttft_slow, "", engines[0]))
    if args.backend in ("cpu", "both"):
        for engine in engines:
            out.append((f"CPU{tag(engine)}", "cpu", args.ttft, "real" if "real" in smart_modes else "", engine))
    return [s for s in out if not args.only or args.only.lower() in s[0].lower()]


def run_light(args, work):
    from core import kokoro_voice, turn_detect
    fixtures, barge = build_fixtures(work / "fixtures")
    texts = {f["name"]: f["text"] for f in fixtures}
    smart = args.smart_turn == "real"
    kokoro = args.voice_engine == "kokoro"
    saved = (turn_detect.SESSION_FACTORY, kokoro_voice.ENGINE_FACTORY)
    previous = None
    if smart or kokoro:
        # The app's real modules with fake model sessions: a throwaway folder holds empty files where the downloads go.
        onnx = work / "onnx"; onnx.mkdir()
        for name in ("smart-turn.onnx", "kokoro-model.onnx", "kokoro-voices.bin"):
            (onnx / name).write_bytes(b"")
        previous = use_onnx_dir(onnx)
        turn_detect.SESSION_FACTORY = lambda _path: FakeTurnSession()
        kokoro_voice.ENGINE_FACTORY = lambda _model, _voices: FakeKokoro()
    services = Services(True, "cuda", "small.en", texts=texts, voice_engine="kokoro" if kokoro else "sapi")
    try:
        summaries = []
        runs = (("slow model", 900), ("fast model", 60)) if not (smart or kokoro) else (("fast model", 60),)
        for label, ttft in runs:
            result = run_harness(harness_config(services, fixtures, barge, "cuda", args, filler=900, ttft=ttft, smart="real" if smart else ""), work)
            summaries.append(summarize(result, fixtures, label + (" +SmartTurn" if smart else "") + (" +Kokoro" if kokoro else "")))
        what = "fake speech-to-text 150 ms and voice 50 ms" + (", fake Smart Turn session" if smart else "") + (", fake Kokoro engine" if kokoro else "")
        return summaries, table(summaries, f"CI-light ({what}, synthetic audio)")
    finally:
        services.close()
        turn_detect.SESSION_FACTORY, kokoro_voice.ENGINE_FACTORY = saved
        if previous is not None:
            use_onnx_dir(previous)


def run(args):
    """Returns (summaries, text). The one entry point the unit test and main() share."""
    work = Path(tempfile.mkdtemp(prefix="kairos-bench-"))
    try:
        sys.path.insert(0, str(ROOT))
        if args.light:
            return run_light(args, work)

        # full mode: the data directory is a throwaway; the existing speech models and GPU runtime are only read
        os.environ["JARVIS_DATA_DIR"] = str(work / "data")
        os.makedirs(work / "data", exist_ok=True)
        from core import hd_voice, kokoro_voice, speech, speech_acceleration, turn_detect
        scenarios = scenario_list(args)
        wants_hd = any(s[4] == "hd" for s in scenarios)
        if wants_hd:
            hd_voice.HD_DIR = args.hd_dir or str(ROOT / "data" / "speech_models" / "hd_voice")
            ok, reason = hd_voice.ready()
            if not ok:
                raise SystemExit(f"HD voice is not usable from {hd_voice.HD_DIR}: {reason}")
        wants_smart = any(s[3] == "real" for s in scenarios)
        wants_kokoro = any(s[4] == "kokoro" for s in scenarios) or args.kokoro_bench
        models = args.models_dir or detect_models_dir()
        if scenarios and not models:
            raise SystemExit("No whisper small.en model found. Pass --models-dir (read-only) or use --light.")
        if models:
            speech.SPEECH_DIR = models
        warm, extra = {}, ""
        if wants_smart or wants_kokoro:
            onnx = args.onnx_dir or detect_onnx_dir(models)
            if not onnx:
                raise SystemExit("No optional speech models folder found. Pass --onnx-dir (read-only).")
            use_onnx_dir(onnx)
            for name, wanted, module in (("Smart Turn", wants_smart, turn_detect), ("Kokoro", wants_kokoro, kokoro_voice)):
                ok, reason = module.ready()
                if wanted and not ok:
                    raise SystemExit(f"{name} is not usable from {onnx}: {reason}")
            if args.kokoro_bench:
                say(f"Kokoro on its own ({args.kokoro_bench} renders per sentence) ...")
                extra = kokoro_table(kokoro_bench(args.kokoro_bench, args.kokoro_voice, args.kokoro_gap), args.kokoro_bench)
            # The live turns: Kokoro on the provider the app would pick, or the one --kokoro-provider pins.
            kokoro_voice.FORCE_PROVIDER = dict(PROVIDERS).get(args.kokoro_provider) if args.kokoro_provider != "auto" else None
            if args.warm:
                warm = warm_models(wants_smart, any(s[4] == "kokoro" for s in scenarios), args.hd_voice if wants_hd else None)
                say(f"warmed {warm}")
        elif wants_hd and args.warm:
            warm = warm_models(False, False, args.hd_voice)
            say(f"warmed {warm}")
        if not scenarios:
            return [], extra.strip()
        sapi = SapiWorker(args.voice)
        say("rendering fixtures with the OS voice ...")
        fixtures, barge = build_fixtures(work / "fixtures", render=sapi.samples)
        filler = sapi.render(FILLER_TEXT)
        spoken_filler = pcm_to_float(filler["raw"])
        first, last = edges(spoken_filler, 0.01)
        filler_ms = round((last - first) / 16) + 40   # the clip as it would be cached: the voice's own padding trimmed
        summaries, hardware, active = [], [], None
        for label, backend, ttft, smart, engine in scenarios:
            if active != backend:
                if backend == "cuda":
                    runtime = args.runtime or detect_runtime()
                    if not runtime:
                        say("no whisper.cpp CUDA runtime found: skipping the GPU path"); continue
                    speech_acceleration.register(runtime)
                    info = speech.prepare_call("small.en", "auto")
                    if info["engine"] != "cuda":
                        say("the GPU runtime did not start (" + str(info.get("fallback")) + "): skipping the GPU path"); continue
                    hardware.append("GPU: whisper.cpp CUDA server, small.en")
                else:
                    speech_acceleration.unregister()
                    speech.prepare_call("small.en", "cpu")
                    hardware.append(f"CPU: pywhispercpp small.en, {os.cpu_count()} logical cores")
                active = backend
            services = Services(False, backend, "small.en", sapi=sapi, voice_engine=engine, kokoro_voice_name=args.kokoro_voice, hd_voice_name=args.hd_voice)
            try:
                say(f"running {label} ({args.repeats} x {len(fixtures)} turns, real time) ...")
                result = run_harness(harness_config(services, fixtures, barge, backend, args, filler=filler_ms, ttft=ttft, smart=smart), work)
                summaries.append(summarize(result, fixtures, label))
                if services.hd_first:
                    summaries[-1]["hd_first_audio"] = {"p50": percentile(services.hd_first, 0.5), "p95": percentile(services.hd_first, 0.95), "n": len(services.hd_first)}
                if services.turn_ms and summaries[-1].get("smart"):
                    summaries[-1]["smart"]["model_p50"] = percentile(services.turn_ms, 0.5)
                    summaries[-1]["smart"]["model_p95"] = percentile(services.turn_ms, 0.95)
                if args.out:
                    Path(args.out).mkdir(parents=True, exist_ok=True)
                    (Path(args.out) / ("raw-" + label.replace(" ", "_").replace("*", "").replace("+", "_") + ".json")).write_text(json.dumps(result), encoding="utf-8")
            finally:
                services.close()
        speech_acceleration.stop()
        sapi.close()
        voices = f"SAPI voice '{args.voice}'" + (f", Kokoro voice '{args.kokoro_voice}' on {kokoro_voice.device()['provider']}" if wants_kokoro else "") \
            + (f", HD voice '{args.hd_voice}' (Qwen3-TTS 0.6B, sidecar, {hd_voice.gpu()['card']['name']})" if wants_hd else "")
        if wants_hd:
            hd_voice.stop()
        meta = (f"{'; '.join(hardware)}; {voices}; scripted model first token {args.ttft} ms at {args.tokens_per_s} tokens/s; {args.repeats} x {len(fixtures)} turns"
                + (f"; warmed at call start {warm}" if warm else ""))
        return summaries, table(summaries, meta) + ("\n" + extra if extra else "")
    finally:
        shutil.rmtree(work, ignore_errors=True)


CONVERSATION_TURNS = ["Hi, can you hear me?", "What's a good name for a coffee shop?", "Give me one more idea.",
                      "Thanks. What time of day do people drink the most coffee?", "Great, that's all for now."]
SENTENCE_END = re.compile(r"[.!?](\s|$)")


def conversation_bench(targets, repeats):
    """The call's real conversation layer (services/agent_calls.py makes the same objects) on real connections: time from
    sending a turn to its first text and to its first whole sentence (what the call can start speaking), warm (after the
    call-start prepare, which is timed on its own). Targets: claude_cli, codex_cli, antigravity_cli (this machine's own
    sign-ins), or ollama:<model> / api:<base url>:<model> (key from BENCH_API_KEY). Uses a throwaway data folder."""
    import asyncio
    import contextlib
    from unittest.mock import patch
    os.environ.setdefault("JARVIS_DATA_DIR", tempfile.mkdtemp(prefix="kairos-bench-"))
    sys.path.insert(0, str(ROOT))
    from core import cli_dialogue, model_endpoints, voice_dialogue

    def make(target):
        kind, _, rest = target.partition(":")
        if kind in cli_dialogue.CLI_KINDS:   # claude_cli, or claude_cli:<model>
            return contextlib.nullcontext(), cli_dialogue.conversation_for({"id": "bench", "kind": kind, "model": ""}, rest or None)
        if kind == "ollama":
            runtime, endpoint = ("http://localhost:11434/v1", rest, None, 4096), {"kind": "local"}
        else:
            base, _, model = rest.rpartition(":")
            runtime, endpoint = (base, model, os.environ.get("BENCH_API_KEY"), 4096), {"kind": "api"}
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(model_endpoints, "get_endpoint", return_value=endpoint))
        stack.enter_context(patch.object(model_endpoints, "resolve_runtime", return_value=runtime))
        return stack, voice_dialogue.Conversation("bench")

    async def one(target):
        stack, conversation = make(target)
        rows = {"target": target, "prepare_ms": None, "first_text_ms": [], "first_sentence_ms": [], "errors": []}
        with stack:
            try:
                started = time.perf_counter()
                await conversation.prepare()
                rows["prepare_ms"] = round((time.perf_counter() - started) * 1000)
                history = []
                for turn in (CONVERSATION_TURNS * repeats)[:max(1, len(CONVERSATION_TURNS) * repeats)]:
                    history.append({"role": "user", "content": turn})
                    messages = [{"role": "system", "content": voice_dialogue.VOICE_PROMPT + "\nYour name: Bench."}] + history
                    text, first, sentence, started = "", None, None, time.perf_counter()
                    try:
                        async with contextlib.aclosing(conversation.stream(messages)) as stream:
                            async for delta in stream:
                                now = round((time.perf_counter() - started) * 1000)
                                first = now if first is None else first
                                text += delta
                                if sentence is None and SENTENCE_END.search(text):
                                    sentence = now
                    except Exception as error:
                        rows["errors"].append(f"{type(error).__name__}: {error}"[:200]); history.pop(); continue
                    rows["first_text_ms"].append(first)
                    rows["first_sentence_ms"].append(sentence if sentence is not None else round((time.perf_counter() - started) * 1000))
                    history.append({"role": "assistant", "content": text})
            except Exception as error:
                rows["errors"].append(f"{type(error).__name__}: {error}"[:200])
            finally:
                await conversation.close()
        return rows

    def stat(values):
        values = [v for v in values if v is not None]
        if not values:
            return "-"
        ordered = sorted(values)
        return f"{statistics.median(ordered):>6.0f} / {ordered[min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))]:>6.0f}"

    results = [asyncio.run(one(target)) for target in targets]
    lines = ["Call conversation layer, warm turns (ms, p50 / p95)", f"{'connection':<28}{'call start':>11}{'first text':>17}{'first sentence':>17}  turns"]
    for row in results:
        lines.append(f"{row['target']:<28}{str(row['prepare_ms'] if row['prepare_ms'] is not None else '-'):>11}{stat(row['first_text_ms']):>17}"
                     f"{stat(row['first_sentence_ms']):>17}  {len(row['first_sentence_ms'])}" + (f"  errors: {row['errors'][:2]}" if row["errors"] else ""))
    return results, "\n".join(lines)


def parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--conversation", nargs="+", metavar="TARGET",
                   help="time the call's real conversation layer instead: claude_cli, codex_cli, antigravity_cli, ollama:<model> "
                        "or api:<base url>:<model> (see conversation_bench); --repeats passes over five turns")
    p.add_argument("--light", action="store_true", help="CI-light: fake speech-to-text and voice, synthetic audio, no models needed")
    p.add_argument("--realtime", action="store_true", help="with --light: feed audio at real-time pace too")
    p.add_argument("--backend", choices=["cuda", "cpu", "both", "none"], default="both", help="none: no voice turns (with --kokoro-bench)")
    p.add_argument("--repeats", type=int, default=5, help="passes over the four fixtures")
    p.add_argument("--barge-repeats", type=int, default=6)
    p.add_argument("--ttft", type=int, default=350, help="the scripted model's first-token delay in ms")
    p.add_argument("--ttft-slow", type=int, default=900, help="also run the GPU path with a slower model (shows the acknowledgement); 0 = skip")
    p.add_argument("--smart-turn", choices=["off", "oracle", "real", "all"], default="oracle",
                   help="end of turn by meaning on the GPU path: oracle = a perfect stand-in, real = the Smart Turn model through "
                        "core/turn_detect.py (also used on the CPU path), all = both; the plain silence wait always runs too")
    p.add_argument("--voice-engine", choices=["sapi", "kokoro", "both", "hd"], default="sapi", help="the reply's voice: Windows SAPI, Kokoro through core/kokoro_voice.py, or HD through core/hd_voice.py")
    p.add_argument("--hd-voice", default="iris", choices=["iris", "ryan", "aiden"], help="HD voice id")
    p.add_argument("--hd-dir", default=None, help="an installed HD voice folder (read-only; default: this checkout's data\\speech_models\\hd_voice)")
    p.add_argument("--kokoro-voice", default="default", help="Kokoro voice id (default: the app's default voice)")
    p.add_argument("--kokoro-bench", type=int, default=0, help="also time Kokoro on its own: renders per sentence on each available provider; 0 = skip")
    p.add_argument("--kokoro-gap", type=int, default=0, help="with --kokoro-bench: also render 'Sure thing.' this many times after each idle gap (2, 5, 8 s); 0 = skip")
    p.add_argument("--kokoro-provider", choices=["auto", "CPU", "DirectML", "CUDA"], default="auto", help="the provider Kokoro uses in the voice turns: auto = what the app picks")
    p.add_argument("--warm", action=argparse.BooleanOptionalAction, default=True,
                   help="load and run Smart Turn and Kokoro once before the turns, as a call start does")
    p.add_argument("--tokens-per-s", type=float, default=60)
    p.add_argument("--leak-gain", type=float, default=0.08, help="echo left after cancellation, relative to the reply's loudness")
    p.add_argument("--voice", default="Microsoft Zira Desktop")
    p.add_argument("--models-dir", help="folder holding ggml-small.en.bin (read only)")
    p.add_argument("--onnx-dir", help="folder holding the Smart Turn and Kokoro downloads (read only); default: <models-dir>\\onnx, else the dev profile's")
    p.add_argument("--runtime", help="extracted whisper.cpp CUDA folder (read only)")
    p.add_argument("--only", help="run only the scenarios whose label contains this text (GPU, SmartTurn, Kokoro, slow, CPU)")
    p.add_argument("--out", help="folder to save the results table and raw data into")
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    if args.conversation:
        results, text = conversation_bench(args.conversation, max(1, args.repeats))
        print(text)
        if args.out:
            out = Path(args.out)
            out.mkdir(parents=True, exist_ok=True)
            (out / "conversation.txt").write_text(text, encoding="utf-8")
            (out / "conversation.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        return 0
    if args.light:
        args.repeats = min(args.repeats, 1)
    summaries, text = run(args)
    print(text)
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "results.txt").write_text(text, encoding="utf-8")
        (out / "summary.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
