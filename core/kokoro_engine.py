"""Kokoro-82M v1.0 on onnxruntime: phonemes from core/kokoro_g2p.py (misaki) in, 24 kHz float samples out.

Replaces the `kokoro_onnx` package, whose phonemizer path (phonemizer + espeak-ng) is GPL-3.0. What is kept from
kokoro-onnx (github.com/thewh1teagle/kokoro-onnx, MIT, Copyright (c) 2025 github.com/thewh1teagle) is small and
re-written here: how the model is fed (token ids padded with 0, one style row per phoneme count, the speed input),
the phoneme vocabulary (the same table as hexgrad/Kokoro-82M's config.json, Apache-2.0), and the rule for cutting a
long phoneme string into batches the model can take (at most 510 phonemes, cut at a sentence, then a clause, then a
word). Nothing of its espeak or phonemizer code is used.

Edge trim (an idea from the Voicebox study, 2026-11-10): the model pads every clip with near-silence before and
after the speech. `trim()` cuts it to a short margin, so the first sentence of a reply starts sounding sooner and
sentences do not carry dead air between them.
"""
import numpy as np

SAMPLE_RATE = 24000
MAX_PHONEMES = 510

# Kokoro v1.0's phoneme vocabulary: SYMBOLS[n] has token id IDS[n] (gaps are unused ids).
SYMBOLS = (';:,.!?—…"()“” ̃ʣʥʦʨᵝꭧAIOQSTWYᵊabcdefhijklmnopqrstuvwxyzɑɐɒæβɔɕçɖðʤəɚɛɜɟɡɥɨɪʝɯɰŋɳɲɴøɸθœɹɾɻʁɽʂʃʈʧʊʋʌɣɤχʎʒʔˈˌːʰʲ↓→↗↘ᵻ')
IDS = (1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31, 33, 35, 36, 39, 41,
       42, 43, 44, 45, 46, 47, 48, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70,
       71, 72, 75, 76, 77, 78, 80, 81, 82, 83, 85, 86, 87, 90, 92, 99, 101, 102, 103, 110, 111, 112, 113, 114, 115,
       116, 118, 119, 120, 123, 125, 126, 128, 129, 130, 131, 132, 133, 135, 136, 138, 139, 140, 142, 143, 147, 148,
       156, 157, 158, 162, 164, 169, 171, 172, 173, 177)
VOCAB = dict(zip(SYMBOLS, IDS))

SENTENCE_MARKS, CLAUSE_MARKS = ".!?…", ",;:"
SENTENCE_PAUSE, CLAUSE_PAUSE = 0.25, 0.1        # seconds added where a long text was cut into batches

# Edge trim. A 10 ms frame counts as sound when its loudness is within TRIM_DB of the clip's loudest frame. The
# margins keep a soft onset (an "h", an "f") and the natural decay of the last word.
TRIM_DB = 45.0
TRIM_FRAME = 240                                # 10 ms at 24 kHz
LEAD_MARGIN = 0.03                              # seconds kept before the first loud frame
TAIL_MARGIN = 0.08                              # and after the last


def trim(audio: np.ndarray) -> tuple[np.ndarray, int, int]:
    """(trimmed audio, samples cut at the start, samples cut at the end). A silent clip is returned untouched."""
    n = len(audio) // TRIM_FRAME
    if n < 3:
        return audio, 0, 0
    frames = audio[:n * TRIM_FRAME].astype(np.float32).reshape(n, TRIM_FRAME)
    loudness = np.sqrt((frames ** 2).mean(axis=1))
    peak = float(loudness.max())
    if peak <= 1e-6:
        return audio, 0, 0
    loud = np.flatnonzero(loudness >= peak * 10 ** (-TRIM_DB / 20))
    start = max(0, int(loud[0]) * TRIM_FRAME - int(LEAD_MARGIN * SAMPLE_RATE))
    end = min(len(audio), (int(loud[-1]) + 1) * TRIM_FRAME + int(TAIL_MARGIN * SAMPLE_RATE))
    return audio[start:end], start, len(audio) - end


def split_phonemes(phonemes: str, limit: int = MAX_PHONEMES) -> list[str]:
    """Batches of at most `limit` phonemes, cut at the least disruptive place: sentence, clause, word, then anywhere."""
    phonemes = " ".join(phonemes.split())
    if len(phonemes) <= limit:
        return [phonemes] if phonemes else []
    for marks in (SENTENCE_MARKS, CLAUSE_MARKS, None):
        cut = _last_cut(phonemes, limit, marks)
        if cut:
            return [phonemes[:cut].strip()] + split_phonemes(phonemes[cut:], limit)
    return [phonemes[:limit]] + split_phonemes(phonemes[limit:], limit)


def _last_cut(text: str, limit: int, marks: str | None) -> int:
    """The index just after the last space within `limit` that follows one of `marks` (any space when None)."""
    for i in range(min(limit, len(text) - 1), 0, -1):
        if text[i] == " " and (marks is None or text[i - 1] in marks):
            return i
    return 0


def pause_after(batch: str) -> float:
    mark = batch.rstrip()[-1:]
    return SENTENCE_PAUSE if mark in SENTENCE_MARKS else CLAUSE_PAUSE if mark in CLAUSE_MARKS else 0.0


class KokoroEngine:
    """The engine core/kokoro_voice.py drives: get_voices() and create(text, voice=, speed=, lang=)."""

    def __init__(self, session, voices_path: str, phonemize=None):
        if phonemize is None:
            from core import kokoro_g2p
            phonemize = kokoro_g2p.phonemize
        self.sess = session
        self.phonemize = phonemize
        with np.load(voices_path) as packed:
            self.voices = {name: np.asarray(packed[name], dtype=np.float32) for name in packed.files}
        types = {i.name: i.type for i in session.get_inputs()}
        self._tokens_input = "input_ids" if "input_ids" in types else "tokens"
        self._speed_type = np.int32 if types.get("speed") in ("tensor(int32)", "tensor(int64)") else np.float32

    def get_voices(self) -> list[str]:
        return sorted(self.voices)

    def tokens(self, phonemes: str) -> list[int]:
        return [VOCAB[p] for p in phonemes if p in VOCAB]

    def _infer(self, tokens: list[int], style: np.ndarray, speed: float) -> np.ndarray:
        inputs = {self._tokens_input: np.array([[0, *tokens, 0]], dtype=np.int64), "style": style,
                  "speed": np.array([speed], dtype=self._speed_type)}
        return np.asarray(self.sess.run(None, inputs)[0], dtype=np.float32).ravel()

    def create(self, text: str, voice: str, speed: float = 1.0, lang: str = "en-us", trim_edges: bool = True):
        """(float32 samples, 24000). Raises ValueError for an unknown voice or text with nothing speakable."""
        if voice not in self.voices:
            raise ValueError(f"Voice {voice} not found")
        pack = self.voices[voice]
        batches = split_phonemes(self.phonemize(text, lang))
        parts = []
        for n, batch in enumerate(batches):
            tokens = self.tokens(batch)
            if not tokens:
                continue
            audio = self._infer(tokens, pack[min(len(tokens), len(pack)) - 1], speed)
            if trim_edges:
                audio = trim(audio)[0]
            parts.append(audio)
            if n < len(batches) - 1 and pause_after(batch):
                parts.append(np.zeros(int(pause_after(batch) * SAMPLE_RATE), dtype=np.float32))
        if not parts:
            raise ValueError(f"Nothing to say in {text!r}")
        return np.concatenate(parts), SAMPLE_RATE
