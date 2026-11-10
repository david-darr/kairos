"""Text to Kokoro phonemes with misaki, Kokoro's own G2P (github.com/hexgrad/misaki, Apache-2.0). No espeak-ng.

David's call 2026-11-10 ("Yes, use misaki"): Kokoro has to ship to every user, so nothing GPL may sit in its path.
misaki's English G2P is a dictionary lookup (its gold and silver lexicons) steered by spaCy's part-of-speech tags
(en_core_web_sm, MIT), with numbers, money, dates and times spelled out by num2words (LGPL-2.1, used unmodified as a
separately installed package). misaki can hand words it does not know to espeak-ng; that fallback is OFF here
(`fallback=None`) and the espeak packages are not installed in the shipped runtime.

A word misaki does not know (a rare name, a made-up word) comes back with no phonemes. It must never cost the rest of
the sentence, so `guess()` reads it with plain English spelling rules instead (an approximation, written for Kairos;
a word with no vowel at all is spelled out letter by letter). The seam for something better is `FALLBACK`: a
callable `(word, british) -> phonemes or None` tried before the rules. Other languages, later, may plug an optional
espeak-ng in there as a separate program the user downloads themselves; it is never bundled and nothing sets it today.

Only American (en-US) and British (en-GB) English are read. A voice for another language reads English text with the
American rules, as it did before. spaCy is never allowed to download its model by itself (misaki would call pip if the
model were missing): `missing()` checks first and Kokoro reports why it is not ready instead.
"""
import importlib.util
import logging
import re
import threading

logger = logging.getLogger(__name__)

SPACY_MODEL = "en_core_web_sm"
# Python modules Kokoro's phonemes need (core/speech_optional.py names them in Settings > Speech when one is missing).
MODULES = ("misaki", "spacy", SPACY_MODEL, "num2words")

# Tried before the spelling rules for a word misaki does not know. None: nothing installed (see the module docstring).
FALLBACK = None

UNK = "❓"                      # misaki's marker for a word it could not read (never spoken: not in Kokoro's vocabulary)

_lock = threading.Lock()
_g2p: dict[bool, object] = {}      # british -> misaki G2P


def _have(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def missing() -> list[str]:
    return [m for m in MODULES if not _have(m)]


def lang_for_voice(voice: str | None) -> str:
    """Kokoro voice ids start with their language: "a" American, "b" British (bf_emma, bm_george)."""
    return "en-gb" if (voice or "").startswith("b") else "en-us"


def _load(british: bool):
    with _lock:
        if british in _g2p:
            return _g2p[british]
    gone = missing()
    if gone:
        raise RuntimeError("Kokoro's phonemizer is missing: " + ", ".join(gone))
    from misaki import en
    g2p = en.G2P(trf=False, british=british, fallback=None, unk=UNK)
    with _lock:
        return _g2p.setdefault(british, g2p)


def warm(british: bool = False) -> None:
    _load(british)


def reset() -> None:
    with _lock:
        _g2p.clear()


def phonemize(text: str, lang: str = "en-us") -> str:
    """Kokoro phonemes for `text`. Unknown words are guessed (never dropped silently, never a crash)."""
    british = lang == "en-gb"
    g2p = _load(british)
    text = expand(text)
    with _lock:                       # spaCy and misaki keep per-call state; one sentence at a time
        _, tokens = g2p(text)
    out = []
    for tk in tokens:
        ps = tk.phonemes
        # misaki leaves a word it cannot read as None, marks an unreadable part of a word with UNK, and reads some
        # abbreviations it does not know ("Inc.") as nothing at all. None of those may vanish from the sentence.
        lettered = any(c.isalpha() for c in tk.text)
        if ps is None or (lettered and (UNK in ps or not ps)):
            ps = _unknown(tk.text, british)
        ps = ps.replace(UNK, "")                  # an unreadable symbol inside "10:30" is just left out
        out.append(ps + (" " if tk.whitespace else ""))
    return "".join(out).strip()


# -- written forms misaki reads badly, spelled out first ----------------------------------------------------------------
# Measured 2026-11-10 against the espeak path: misaki reads "St.", "Nov.", "Jan.", "Mt.", "Jr." as silence, "lbs" and
# "km" as nothing, and "555-0123" as "five hundred fifty five-one twenty three".
_MONTHS = {"Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April", "Jun": "June", "Jul": "July",
           "Aug": "August", "Sep": "September", "Sept": "September", "Oct": "October", "Nov": "November",
           "Dec": "December", "Mon": "Monday", "Tue": "Tuesday", "Tues": "Tuesday", "Wed": "Wednesday",
           "Thu": "Thursday", "Thur": "Thursday", "Thurs": "Thursday", "Fri": "Friday"}
_WORDS = {"Mt": "Mount", "Ave": "Avenue", "Blvd": "Boulevard", "Rd": "Road", "Jr": "Junior", "Sr": "Senior",
          "Inc": "Incorporated", "Ltd": "Limited", "Corp": "Corporation", "Dept": "Department", "Apt": "Apartment",
          "Mx": "Mix", "approx": "approximately", "Approx": "Approximately"}
_UNITS = {"lb": ("pound", "pounds"), "lbs": ("pound", "pounds"), "oz": ("ounce", "ounces"), "kg": ("kilogram", "kilograms"),
          "km": ("kilometer", "kilometers"), "cm": ("centimeter", "centimeters"), "mm": ("millimeter", "millimeters"),
          "ft": ("foot", "feet"), "mi": ("mile", "miles"), "mph": ("mile per hour", "miles per hour"),
          "kph": ("kilometer per hour", "kilometers per hour"), "hr": ("hour", "hours"), "hrs": ("hour", "hours"),
          "min": ("minute", "minutes"), "mins": ("minute", "minutes"), "sec": ("second", "seconds"), "secs": ("second", "seconds")}
_DIGITS = "zero one two three four five six seven eight nine".split()

_ABBREV = re.compile(r"\b(" + "|".join(sorted({**_MONTHS, **_WORDS}, key=len, reverse=True)) + r")\.(?=(\s+\S)?)")
_ST = re.compile(r"\bSt\.")
_UNIT = re.compile(r"\b(\d+(?:[.,]\d+)?)\s?(" + "|".join(sorted(_UNITS, key=len, reverse=True)) + r")\b")
_PHONE = re.compile(r"(?<![\d-])(?:\(\d{3}\)\s?|\d{3}[-.])?\d{3}-\d{4}(?![\d-])")


def _spell_digits(match) -> str:
    groups = re.findall(r"\d+", match.group(0))
    return ", ".join(" ".join(_DIGITS[int(d)] for d in group) for group in groups)


def _abbrev(match) -> str:
    word = {**_MONTHS, **_WORDS}[match.group(1)]
    following = match.group(2)
    # Keep the full stop when the abbreviation ended the sentence: the end of the text, or a new sentence after it.
    # "Mt." always comes before its name.
    ends = following is None or (following.strip()[:1].isupper() and match.group(1) != "Mt")
    return word + ("." if ends else "")


def _st(text: str) -> str:
    """"St." is Street after a name or number ("Elm St.", "5th St."), Saint before a name ("St. Louis")."""
    def one(match):
        before, after = text[:match.start()].rstrip(), text[match.end():]
        words = before.split()
        named = bool(words) and len(words) > 1 and (words[-1][:1].isupper() or words[-1][:1].isdigit())
        named = named or (len(words) == 1 and words[0][:1].isdigit())
        capital_next = re.match(r"\s+[A-Z]", after) is not None
        if not named and capital_next:
            return "Saint"
        return "Street" + ("." if capital_next or not after.strip() else "")
    return _ST.sub(one, text)


def expand(text: str) -> str:
    """Spell out the abbreviations, units and phone numbers misaki misreads (see the table above)."""
    text = _PHONE.sub(_spell_digits, text)
    text = _st(text)
    text = _ABBREV.sub(_abbrev, text)
    return _UNIT.sub(lambda m: m.group(1) + " " + _UNITS[m.group(2)][0 if m.group(1) == "1" else 1], text)


def _unknown(word: str, british: bool) -> str:
    if FALLBACK is not None:
        try:
            ps = FALLBACK(word, british)
            if ps:
                return ps
        except Exception:
            logger.exception("kokoro: the unknown-word fallback failed on %r", word)
    return guess(word)


# -- spelling rules for a word misaki does not know -------------------------------------------------------------------
# Output is misaki's phoneme set (Kokoro's vocabulary): A=ay, I=eye, O=oh, W=ow, Y=oy, plus IPA.

LETTERS = {"a": "ˈA", "b": "bˈi", "c": "sˈi", "d": "dˈi", "e": "ˈi", "f": "ˈɛf", "g": "ʤˈi", "h": "ˈAʧ", "i": "ˈI",
           "j": "ʤˈA", "k": "kˈA", "l": "ˈɛl", "m": "ˈɛm", "n": "ˈɛn", "o": "ˈO", "p": "pˈi", "q": "kjˈu", "r": "ˈɑɹ",
           "s": "ˈɛs", "t": "tˈi", "u": "jˈu", "v": "vˈi", "w": "dˈʌbᵊlju", "x": "ˈɛks", "y": "wˈI", "z": "zˈi"}

VOWELS = set("aeiouy")
# Longest first. Each maps a spelling to its usual English sound.
_CHUNKS = [
    ("tion", "ʃən"), ("sion", "ʒən"), ("ture", "ʧəɹ"), ("eigh", "A"), ("augh", "ɔ"),
    ("igh", "I"), ("tch", "ʧ"), ("sch", "sk"), ("dge", "ʤ"),
    ("ph", "f"), ("sh", "ʃ"), ("ch", "ʧ"), ("th", "θ"), ("wh", "w"), ("ck", "k"), ("ng", "ŋ"), ("qu", "kw"),
    ("ee", "i"), ("ea", "i"), ("oo", "u"), ("ou", "W"), ("ow", "O"), ("oi", "Y"), ("oy", "Y"), ("ai", "A"),
    ("ay", "A"), ("ei", "A"), ("ey", "A"), ("au", "ɔ"), ("aw", "ɔ"), ("ie", "i"), ("ue", "u"), ("ui", "u"),
    ("oa", "O"), ("ar", "ɑɹ"), ("or", "ɔɹ"), ("er", "ɜɹ"), ("ir", "ɜɹ"), ("ur", "ɜɹ"),
]
_CONSONANTS = {"b": "b", "d": "d", "f": "f", "h": "h", "j": "ʤ", "k": "k", "l": "l", "m": "m", "n": "n", "p": "p",
               "r": "ɹ", "s": "s", "t": "t", "v": "v", "w": "w", "x": "ks", "z": "z", "q": "k"}
_SHORT = {"a": "æ", "e": "ɛ", "i": "ɪ", "o": "ɑ", "u": "ʌ", "y": "ɪ"}
_OPEN = {"a": "ɑ", "e": "A", "i": "i", "o": "O", "u": "u", "y": "I"}     # a vowel ending its syllable: ko-ko-ro
_FINAL = {"a": "ə", "e": "i", "i": "i", "o": "O", "u": "u", "y": "i"}
_STRESSABLE = set("AIOWYiuɑɔɛɜɪʊʌæəᵊ")


def guess(word: str) -> str:
    """Phonemes for an unknown word from its spelling. Empty for a token with no letters (a stray symbol)."""
    letters = "".join(c for c in word.lower() if "a" <= c <= "z")
    if not letters:
        return ""
    if not (set(letters) & VOWELS) or (word.isupper() and len(letters) <= 4):
        return "".join(LETTERS[c] for c in letters)          # "Qwghlm", "XKCD": spell it
    w = letters
    if w.startswith(("kn", "gn", "wr")):
        w = w[1:]
    magic = len(w) > 3 and w.endswith("e") and w[-2] not in VOWELS and w[-3] in VOWELS and w[-4] not in VOWELS
    if magic:
        w = w[:-1]
    out, i = [], 0
    while i < len(w):
        for spelling, sound in _CHUNKS:
            if w.startswith(spelling, i):
                out.append(sound)
                i += len(spelling)
                break
        else:
            c, nxt = w[i], w[i + 1] if i + 1 < len(w) else ""
            after = w[i + 2] if i + 2 < len(w) else ""
            if c == "y" and (i == 0 or (w[i - 1] in VOWELS and nxt in VOWELS)):
                out.append("j")                               # "Yara", "Priya": y as a consonant
            elif c in VOWELS:
                if i == len(w) - 1 and not magic:
                    alone = not (set(w[:-1]) & VOWELS)          # "sky", "fly": the only vowel
                    out.append(_OPEN[c] if len(w) <= 2 or alone else _FINAL[c])
                elif magic and i == len(w) - 2:
                    out.append(_OPEN[c] if c != "a" else "A")
                elif nxt in VOWELS:
                    out.append(_OPEN[c])
                elif nxt and nxt not in VOWELS and after in VOWELS and after:
                    out.append(_OPEN[c])
                else:
                    out.append(_SHORT[c])
            elif c == "c":
                out.append("s" if nxt in ("e", "i", "y") else "k")
            elif c == "g":
                out.append("ʤ" if nxt in ("e", "i", "y") and i > 0 else ("" if nxt == "h" and i > 0 else "ɡ"))
            elif c == "h" and i > 0 and w[i - 1] not in VOWELS:
                pass                                          # "bh", "dh": the h is silent
            else:
                out.append(_CONSONANTS.get(c, ""))
            i += 1
    # Collapse doubled consonant sounds ("ll", "tt") and put the stress before the first vowel.
    merged = []
    for piece in out:
        if piece and merged and piece == merged[-1] and piece not in _STRESSABLE:
            continue
        merged.append(piece)
    ps = "".join(merged)
    for at, ch in enumerate(ps):
        if ch in _STRESSABLE:
            return ps[:at] + "ˈ" + ps[at:]
    return ps
