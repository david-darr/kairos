"""End-to-end voice turn benchmark: real speech audio in, p50/p95 latencies out.

    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py              full run: GPU and CPU, real whisper and OS voice
    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py --backend cuda --repeats 5
    .venv\\Scripts\\python.exe -X utf8 scripts\\bench_voice_turn.py --light      CI-light: fakes for speech-to-text and the voice

What runs for real (full mode)
  speech audio     fixture WAVs rendered offline by the OS voice (Windows SAPI), 16 kHz, with a lead-in, a mid-sentence
                   pause in one of them, and a tail of quiet; plus a faint noise floor
  capture/endpoint the app's own static/js/speechSegments.js SpeechSegments, fed 10 ms blocks at real-time pace
  rolling partials the app's own static/js/partialTranscript.js, against the same engine as the call
  speech-to-text   core/speech.py transcribe_call: pywhispercpp on CPU, or the whisper.cpp CUDA server (core/speech_acceleration)
  turn             a scripted stand-in model (no cloud call): first token after --ttft ms, then --tokens-per-s
  sentences        the app's own createChunker (first clause / first sentence release, 100 ms flush)
  acknowledgement  the app's own createFillerGate (the half-second rule)
  voice            Windows SAPI; "first audio" is the moment the engine first writes audio, plus the 25 ms scheduling lead
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


class Services:
    """STT and TTS over loopback HTTP. Real (whisper + SAPI) or fake (CI-light)."""

    def __init__(self, light, backend, model, sapi=None, texts=None, light_stt_ms=150, light_tts_ms=50):
        self.light, self.backend, self.model, self.sapi = light, backend, model, sapi
        self.texts = texts or {}
        self.light_stt_ms, self.light_tts_ms = light_stt_ms, light_tts_ms
        self.calls = {"final": 0, "partial": 0, "tts": 0}
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
                self.wfile.write(payload)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def handle(self, path, body, fixture):
        started = time.perf_counter()
        if path == "/tts":
            self.calls["tts"] += 1
            text = json.loads(body)["text"]
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
    for metric in metrics:
        values = [t.get(metric) for t in turns]
        summary[metric] = {"p50": percentile(values, 0.5), "p95": percentile(values, 0.95), "n": sum(v is not None for v in values)}
    fillers = [t for t in turns if t.get("filler_ms") is not None]
    summary["filler"] = {"turns": len(fillers), "p50": percentile([t["filler_ms"] for t in fillers], 0.5),
                         "after_filler_p50": percentile([t.get("first_audio_after_filler_ms") for t in fillers], 0.5)}
    summary["wer"] = statistics.mean(wer(texts.get(t["fixture"], ""), t.get("transcript", "")) for t in turns) if turns else None
    summary["stt_modes"] = {mode: sum(1 for t in turns if t.get("stt_mode") == mode) for mode in sorted({t.get("stt_mode") for t in turns if t.get("stt_mode")})}
    summary["by_fixture"] = {}
    for name in [n for n in texts if n not in DIAGNOSTIC]:
        mine = [t for t in turns if t["fixture"] == name]
        summary["by_fixture"][name] = {"first_audio_p50": percentile([t.get("first_audio_ms") for t in mine], 0.5), "stt_p50": percentile([t.get("stt_ms") for t in mine], 0.5), "audio_ms": mine[0]["audio_ms"] if mine else None}
    barges = result["barges"]
    interrupt = [b for b in barges if b["fixture"] == "interrupt"]
    nod = [b for b in barges if b["fixture"] == "nod"]
    stop = [b["duck_ms"] + WORKLET_BLOCK_MS + OUTPUT_BUFFER_MS for b in interrupt if b["duck_ms"] is not None]
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
        lines.append(f"{s['label']}: {s['turns']} turns ({s['failed']} failed; split by the 0.6 s mid-sentence pause {s['splits']}; a 1.0 s pause split {s['long_pause_splits']}/{s['long_pause_n']}), "
                     f"word error {0 if s['wer'] is None else s['wer'] * 100:.0f}%, final pass {s['stt_modes']}, acknowledgement on {s['filler']['turns']} turns "
                     f"(first sound p50 {fmt(s['filler']['p50'])} ms, answer behind it p50 {fmt(s['filler']['after_filler_p50'])} ms), "
                     f"interrupts heard {s['barge']['interrupts_heard']}/{s['barge']['interrupt_n']}, nods ignored {s['barge']['nods_ignored']}/{s['barge']['nod_n']}")
    lines.append("")
    lines.append("by fixture, first audio p50 / speech-to-text p50 (ms): " + "; ".join(
        f"{s['label']}: " + ", ".join(f"{name} {fmt(v['first_audio_p50'])}/{fmt(v['stt_p50'])}" for name, v in s["by_fixture"].items()) for s in summaries))
    lines.append("* SmartTurn: the model is not installed here; a perfect verdict after 15 ms stands in for it. Barge-in stop adds an 8 ms worklet block and a modelled 20 ms output buffer.")
    return "\n".join(lines)


def harness_config(services, fixtures, barge, backend, args, filler, ttft=None, smart=False):
    return {"service_url": services.url, "fixtures": fixtures, "barge": barge, "repeats": args.repeats, "barge_repeats": args.barge_repeats,
            "backend": backend, "partials": backend == "cuda", "pace": 0 if args.light and not args.realtime else 1, "silence_ms": 700,
            "ttft_ms": args.ttft if ttft is None else ttft, "tokens_per_s": args.tokens_per_s, "reply": REPLY, "leak_gain": args.leak_gain,
            "filler_clip": filler is not None, "filler_ms": filler or 0, "smart_turn": "oracle" if smart else "", "smart_ms": 15}


def detect_models_dir():
    for candidate in (os.environ.get("KAIROS_BENCH_MODELS"), r"C:\Users\David\ai-servers\whisper.cpp\models",
                      os.path.join(os.environ.get("APPDATA", ""), "JARVIS-dev", "data", "speech_models")):
        if candidate and (Path(candidate) / "ggml-small.en.bin").is_file():
            return candidate
    return None


def detect_runtime():
    for candidate in (os.environ.get("KAIROS_BENCH_WHISPER_RUNTIME"), r"C:\Users\David\ai-servers\whisper.cpp\Release"):
        if candidate and (Path(candidate) / "whisper-server.exe").is_file() and (Path(candidate) / "ggml-cuda.dll").is_file():
            return candidate
    return None


def run(args):
    """Returns (summaries, text). The one entry point the unit test and main() share."""
    work = Path(tempfile.mkdtemp(prefix="kairos-bench-"))
    try:
        if args.light:
            sys.path.insert(0, str(ROOT))
            fixtures, barge = build_fixtures(work / "fixtures")
            texts = {f["name"]: f["text"] for f in fixtures}
            services = Services(True, "cuda", "small.en", texts=texts)
            try:
                summaries = []
                for label, ttft in (("slow model", 900), ("fast model", 60)):
                    result = run_harness(harness_config(services, fixtures, barge, "cuda", args, filler=900, ttft=ttft), work)
                    summaries.append(summarize(result, fixtures, label))
                return summaries, table(summaries, "CI-light (fake speech-to-text 150 ms and voice 50 ms, synthetic audio)")
            finally:
                services.close()

        # full mode: the data directory is a throwaway; the existing speech models and GPU runtime are only read
        os.environ["JARVIS_DATA_DIR"] = str(work / "data")
        os.makedirs(work / "data", exist_ok=True)
        sys.path.insert(0, str(ROOT))
        from core import speech, speech_acceleration
        models = args.models_dir or detect_models_dir()
        if not models:
            raise SystemExit("No whisper small.en model found. Pass --models-dir (read-only) or use --light.")
        speech.SPEECH_DIR = models
        sapi = SapiWorker(args.voice)
        say("rendering fixtures with the OS voice ...")
        fixtures, barge = build_fixtures(work / "fixtures", render=sapi.samples)
        filler = sapi.render(FILLER_TEXT)
        spoken_filler = pcm_to_float(filler["raw"])
        first, last = edges(spoken_filler, 0.01)
        filler_ms = round((last - first) / 16) + 40   # the clip as it would be cached: the voice's own padding trimmed
        scenarios = []   # (label, backend, ttft, smart turn)
        if args.backend in ("cuda", "both"):
            scenarios += [("GPU", "cuda", args.ttft, False)]
            if args.oracle_smart_turn:
                scenarios += [("GPU+SmartTurn*", "cuda", args.ttft, True)]
            if args.ttft_slow:
                scenarios += [(f"GPU slow {args.ttft_slow}", "cuda", args.ttft_slow, False)]
        if args.backend in ("cpu", "both"):
            scenarios += [("CPU", "cpu", args.ttft, False)]
        summaries, hardware, active = [], [], None
        for label, backend, ttft, smart in scenarios:
            if args.only and args.only.lower() not in label.lower():
                continue
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
            services = Services(False, backend, "small.en", sapi=sapi)
            try:
                say(f"running {label} ({args.repeats} x {len(fixtures)} turns, real time) ...")
                result = run_harness(harness_config(services, fixtures, barge, backend, args, filler=filler_ms, ttft=ttft, smart=smart), work)
                summaries.append(summarize(result, fixtures, label))
                if args.out:
                    Path(args.out).mkdir(parents=True, exist_ok=True)
                    (Path(args.out) / ("raw-" + label.replace(" ", "_").replace("*", "") + ".json")).write_text(json.dumps(result), encoding="utf-8")
            finally:
                services.close()
        speech_acceleration.stop()
        sapi.close()
        meta = f"{'; '.join(hardware)}; SAPI voice '{args.voice}'; scripted model first token {args.ttft} ms at {args.tokens_per_s} tokens/s; {args.repeats} x {len(fixtures)} turns"
        return summaries, table(summaries, meta)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--light", action="store_true", help="CI-light: fake speech-to-text and voice, synthetic audio, no models needed")
    p.add_argument("--realtime", action="store_true", help="with --light: feed audio at real-time pace too")
    p.add_argument("--backend", choices=["cuda", "cpu", "both"], default="both")
    p.add_argument("--repeats", type=int, default=5, help="passes over the four fixtures")
    p.add_argument("--barge-repeats", type=int, default=6)
    p.add_argument("--ttft", type=int, default=350, help="the scripted model's first-token delay in ms")
    p.add_argument("--ttft-slow", type=int, default=900, help="also run the GPU path with a slower model (shows the acknowledgement); 0 = skip")
    p.add_argument("--oracle-smart-turn", action=argparse.BooleanOptionalAction, default=True,
                   help="also run the GPU path with a perfect Smart Turn verdict (the model is not installed here)")
    p.add_argument("--tokens-per-s", type=float, default=60)
    p.add_argument("--leak-gain", type=float, default=0.08, help="echo left after cancellation, relative to the reply's loudness")
    p.add_argument("--voice", default="Microsoft Zira Desktop")
    p.add_argument("--models-dir", help="folder holding ggml-small.en.bin (read only)")
    p.add_argument("--runtime", help="extracted whisper.cpp CUDA folder (read only)")
    p.add_argument("--only", help="run only the scenarios whose label contains this text (GPU, SmartTurn, slow, CPU)")
    p.add_argument("--out", help="folder to save the results table and raw data into")
    return p


def main(argv=None):
    args = parser().parse_args(argv)
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
