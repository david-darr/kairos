"""End of turn by meaning: Pipecat Smart Turn on the audio of the utterance so far (build spec step 5).

Optional on two counts, and both fail closed to today's behaviour (the caller keeps its fixed silence wait):
the model file is a user-started download (core/speech_optional.py) and onnxruntime is not bundled. `ready()` says
which is missing; `predict()` raises TurnUnavailable instead of guessing.

Input contract (Smart Turn v3): 16 kHz mono audio, the last 8 seconds of the utterance, zero-padded at the FRONT to
exactly 8 s, turned into a Whisper-style log-mel spectrogram (80 mel bins x 800 frames), one float32 tensor in, one
probability that the speaker is done out. Implemented here in numpy so no transformers/librosa dependency is needed.
The feature code follows OpenAI Whisper's own front end (n_fft 400, hop 160, Slaney mel filters, log10, floor at
max-8, then (x+4)/4); it is exercised in tests with a fake session, and must be checked once against the real model.
"""
import logging
import threading

from core import speech, speech_optional

logger = logging.getLogger(__name__)

RATE = 16000
WINDOW_SECONDS = 8
N_FFT = 400
HOP = 160
N_MELS = 80
THRESHOLD = 0.5
MIN_SAMPLES = RATE // 5          # under 0.2 s is not an utterance

_lock = threading.Lock()
_session = None
_session_path = None
_filters = None

# A test (or a future alternative runtime) swaps this to supply a session without onnxruntime. Called with the model
# path; must return an object with get_inputs() and run(None, {name: array}).
SESSION_FACTORY = None


class TurnUnavailable(Exception):
    """Message is meant to be shown to the user as-is."""


def reset() -> None:
    global _session, _session_path
    with _lock:
        _session = None
        _session_path = None


def ready() -> tuple[bool, str | None]:
    if SESSION_FACTORY is None:
        missing = speech_optional.missing_runtime("smart-turn")
        if missing:
            return False, speech_optional.runtime_message(missing)
    if not speech_optional.downloaded("smart-turn"):
        return False, "Smart Turn is not downloaded"
    return True, None


def status() -> dict:
    ok, reason = ready()
    return {"ready": ok, "reason": reason, "threshold": THRESHOLD}


def _get_session():
    global _session, _session_path
    path = speech_optional.path_of("smart-turn")
    with _lock:
        if _session is not None and _session_path == path:
            return _session
        if SESSION_FACTORY is not None:
            _session = SESSION_FACTORY(path)
        else:
            import onnxruntime as ort
            # The processor on purpose, even where DirectML is installed: this int8 CPU export fails on DirectML (a
            # Reshape, 2026-11-09) and answers in about 30 ms on one thread here, so a graphics card would not help.
            options = ort.SessionOptions()
            options.inter_op_num_threads = 1
            options.intra_op_num_threads = 1
            _session = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
        _session_path = path
        return _session


def _mel_filters():
    """Slaney-scale, Slaney-normalised triangular mel filters (what Whisper's feature extractor uses)."""
    global _filters
    if _filters is not None:
        return _filters
    import numpy as np
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0

    def to_mel(hz):
        hz = np.asarray(hz, dtype=np.float64)
        return np.where(hz >= min_log_hz, min_log_mel + np.log(np.maximum(hz, 1e-10) / min_log_hz) / logstep, hz / f_sp)

    def to_hz(mel):
        mel = np.asarray(mel, dtype=np.float64)
        return np.where(mel >= min_log_mel, min_log_hz * np.exp(logstep * (mel - min_log_mel)), mel * f_sp)

    fft_freqs = np.linspace(0, RATE / 2, 1 + N_FFT // 2)
    mel_f = to_hz(np.linspace(to_mel(0.0), to_mel(RATE / 2), N_MELS + 2))
    fdiff = np.diff(mel_f)
    ramps = mel_f[:, None] - fft_freqs[None, :]
    lower = -ramps[:-2] / fdiff[:-1, None]
    upper = ramps[2:] / fdiff[1:, None]
    weights = np.maximum(0, np.minimum(lower, upper))
    weights *= (2.0 / (mel_f[2:N_MELS + 2] - mel_f[:N_MELS]))[:, None]
    _filters = weights.astype(np.float32)
    return _filters


def features(samples):
    """float32 mono 16 kHz samples -> (1, 80, 800) float32 log-mel, the last 8 s, zero-padded at the front."""
    import numpy as np
    length = RATE * WINDOW_SECONDS
    samples = np.asarray(samples, dtype=np.float32)[-length:]
    if len(samples) < length:
        samples = np.concatenate([np.zeros(length - len(samples), dtype=np.float32), samples])
    padded = np.pad(samples, N_FFT // 2, mode="reflect")
    window = np.hanning(N_FFT + 1)[:-1].astype(np.float32)          # periodic Hann, as torch/Whisper use
    frames = 1 + (len(padded) - N_FFT) // HOP
    index = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    spectrum = np.fft.rfft(padded[index] * window, axis=1)
    power = (np.abs(spectrum) ** 2)[:-1].T                           # drop the last frame -> 800
    mel = _mel_filters() @ power.astype(np.float32)
    log_spec = np.log10(np.maximum(mel, 1e-10))
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0).astype(np.float32)[None, :, :]


def probability(samples) -> float:
    session = _get_session()
    name = session.get_inputs()[0].name
    outputs = session.run(None, {name: features(samples)})
    import numpy as np
    return float(np.asarray(outputs[0]).reshape(-1)[0])


def warm() -> bool:
    """Load the model and run it once on silence, so a call's first pause does not pay the load and onnxruntime's
    first-run setup (the first verdict took 645 ms to over a second cold on David's machine, at or past the client's 700 ms ask timeout). A call start
    does this in the background. Never raises; False when Smart Turn is not set up or could not run."""
    if not ready()[0]:
        return False
    try:
        import numpy as np
        probability(np.zeros(RATE, dtype=np.float32))
        return True
    except Exception:
        logger.exception("turn: warm-up failed")
        return False


def predict(audio: bytes) -> dict:
    """16 kHz mono 16-bit WAV of the utterance so far -> {'complete': bool, 'probability': float}.
    Raises TurnUnavailable when the model or runtime is missing, and speech.SpeechUnavailable for bad audio."""
    ok, reason = ready()
    if not ok:
        raise TurnUnavailable(reason)
    if not audio or len(audio) > speech.MAX_AUDIO_BYTES:
        raise speech.SpeechUnavailable("No audio was recorded." if not audio else "That recording is too large.")
    samples = speech._wav_to_float32(audio)
    if len(samples) < MIN_SAMPLES:
        return {"complete": False, "probability": 0.0}
    try:
        value = probability(samples)
    except Exception as e:
        logger.exception("turn: inference failed")
        raise TurnUnavailable("Smart Turn could not run. Check its download.") from e
    return {"complete": value >= THRESHOLD, "probability": round(value, 4)}
