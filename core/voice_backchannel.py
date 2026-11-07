"""Backchannels: the small sounds a listener makes while someone else talks ("mm-hm", "yeah", "right").

They are not turns. While Kairos is speaking or still writing its reply, a transcript made only of these is dropped:
it does not interrupt, it is not sent to the model, and it does not start a reply. The same rule runs in the browser
(static/js/backchannel.js); both are checked against scripts/fixtures/backchannel-cases.json.

The one wrinkle: after Kairos asked a question, "yeah" or "okay" is the answer, not a nod. Then only the pure
noises ("mm-hm", "uh-huh") count as backchannels.
"""
import re

# Pure noises: never an answer to a question.
NOISES = {"mm", "mmm", "mhm", "mmhm", "mm-hm", "mm-hmm", "mmhmm", "hm", "hmm", "uh-huh", "uhhuh", "uh", "um", "ah", "aha", "oh", "ooh", "huh"}
# Words a listener says to show they follow. An answer when Kairos just asked something.
ACKS = {"yeah", "yep", "yup", "yes", "right", "okay", "ok", "sure", "alright", "gotcha", "cool", "nice", "interesting", "wow",
        "exactly", "true", "absolutely", "really", "indeed", "totally", "definitely", "correct", "great", "good", "fine", "kay"}
# Said as a unit: "got it" is a nod, "it" on its own is not.
PHRASES = ("uh huh", "mm hm", "mm hmm", "got it", "i see", "go on", "makes sense", "fair enough", "i get it", "sounds good")
# Anything here makes it a real interruption or a real answer, whatever else is in it.
TAKES_THE_FLOOR = {"no", "nope", "wait", "stop", "hold", "actually", "but", "however", "sorry", "pause", "what", "why", "how",
                   "when", "where", "who", "can", "could", "would", "please", "don't", "dont", "not", "never"}
MAX_WORDS = 5


def _words(text):
    cleaned = " " + re.sub(r"\s+", " ", re.sub(r"[^a-z0-9'\- ]+", " ", str(text or "").lower())) + " "
    for phrase in PHRASES:
        cleaned = cleaned.replace(" " + phrase + " ", " " + phrase.replace(" ", "-") + " ")
    return [word.strip("-'") for word in cleaned.split() if word.strip("-'")]


def is_backchannel(text, asked=False) -> bool:
    """True when `text` is only listener noises. `asked`: Kairos's last spoken sentence was a question."""
    words = _words(text)
    if not words or len(words) > MAX_WORDS:
        return False
    if any(word in TAKES_THE_FLOOR for word in words):
        return False
    allowed = NOISES | {p.replace(" ", "-") for p in PHRASES[:3]} if asked else NOISES | ACKS | {p.replace(" ", "-") for p in PHRASES}
    if not all(word in allowed for word in words):
        return False
    # "yes yes yes" is a nod; five different words that happen to be acks ("good fine cool nice sure") are not worth the risk.
    return len(set(words)) <= 3
