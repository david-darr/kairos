# Kairos addition (2026-11-10), MIT like the rest of Kairos. Replaces the librosa, soundfile and urllib calls in the
# vendored Qwen3-TTS code, so the HD voice environment needs neither librosa (with numba, scipy and scikit-learn) nor
# soundfile, and the code can never fetch audio from the network or decode base64 strings.
import wave

import numpy as np


def load_wav(path):
    """A local 16-bit PCM WAV file -> (mono float32 samples in [-1, 1], sample rate). Nothing else is accepted."""
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2:
            raise ValueError("Only 16-bit PCM WAV reference clips are supported.")
        channels, rate = handle.getnchannels(), handle.getframerate()
        data = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data.astype(np.float32), int(rate)


def resample(y, orig_sr, target_sr):
    """Linear-interpolation resampling. Kairos only feeds 24 kHz audio to a 24 kHz model, so this is a safety net,
    not a quality path."""
    y = np.asarray(y, dtype=np.float32)
    if int(orig_sr) == int(target_sr) or y.size == 0:
        return y
    count = int(round(y.size * float(target_sr) / float(orig_sr)))
    at = np.linspace(0.0, y.size - 1, num=max(count, 1), dtype=np.float64)
    return np.interp(at, np.arange(y.size, dtype=np.float64), y).astype(np.float32)


def _hz_to_mel(freqs):
    """Slaney mel scale (librosa's default, htk=False)."""
    freqs = np.asanyarray(freqs, dtype=np.float64)
    f_sp = 200.0 / 3
    mels = freqs / f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    log_t = freqs >= min_log_hz
    mels = np.where(log_t, min_log_mel + np.log(np.maximum(freqs, 1e-10) / min_log_hz) / logstep, mels)
    return mels


def _mel_to_hz(mels):
    mels = np.asanyarray(mels, dtype=np.float64)
    f_sp = 200.0 / 3
    freqs = f_sp * mels
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    log_t = mels >= min_log_mel
    return np.where(log_t, min_log_hz * np.exp(logstep * (mels - min_log_mel)), freqs)


def mel_filters(sr, n_fft, n_mels=128, fmin=0.0, fmax=None):
    """The same filter bank as librosa.filters.mel(sr=, n_fft=, n_mels=, fmin=, fmax=) with its defaults (Slaney
    scale, Slaney area normalisation), float32, shape (n_mels, 1 + n_fft // 2)."""
    fmax = float(sr) / 2 if fmax is None else float(fmax)
    weights = np.zeros((n_mels, 1 + n_fft // 2), dtype=np.float64)
    fftfreqs = np.fft.rfftfreq(n=n_fft, d=1.0 / sr)
    mel_f = _mel_to_hz(np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2))
    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fftfreqs)
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_f[2: n_mels + 2] - mel_f[:n_mels])
    weights *= enorm[:, np.newaxis]
    return weights.astype(np.float32)
