"""How Kairos talks out loud: the instruction every spoken turn gets, and the text clean-up before a voice reads it.

A voice turn is a call, Open Mic, a phone call or the in-app ring. The model that answers one is told to speak (short
sentences, the answer first, one question at a time, nothing that only makes sense on a screen), and whatever
markdown slips through anyway is stripped before it reaches a voice engine, so a heading or a link is never read out.

static/js/voiceOutput.js `forSpeech` is the same clean-up for the browser's voices; both are checked against one table
of cases (scripts/fixtures/spoken-style-cases.json) so they cannot drift.
"""
import re

CODE_LINE = "I've put the code in the chat."

# No thinking aloud (David, 2026-11-11: calls kept saying "Ok, let me think" and "Mmm ok"). The app no longer plays any
# filler of its own while an answer is written, and the model is told not to make one up: the line stays quiet until
# the answer itself starts. The realtime voices (core/realtime_voice.py, services/realtime_session.py) get it too.
NO_FILLER = ("Answer directly. Never open with filler such as \"let me think\", \"okay so\", \"hmm\", \"good question\" "
             "or \"one moment\", and never think aloud: your first words are the answer.")

# The instruction itself. One text for every kind of voice turn; callers add what is specific to them (the call's
# delegation tag, Open Mic's "the other person is waiting").
VOICE_STYLE = (
    "Spoken-voice mode: your words are read aloud to someone who is listening and waiting to answer. "
    "Speak in short, plain spoken sentences. Answer first, then add detail only if it helps. " + NO_FILLER + " "
    "Never read out markdown, lists, tables, links or code: say what they contain in a sentence and offer to put "
    "the details in the chat. Ask one question at a time, then stop and let them answer."
)

_FENCE = re.compile(r"```.*?(?:```|\Z)", re.S)
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_URL = re.compile(r"https?://\S+|www\.\S+")
_HTML = re.compile(r"</?[A-Za-z][^>]*>")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+", re.M)
_BULLET = re.compile(r"^\s*(?:[-*+•]|\d{1,3}[.)])\s+", re.M)
_QUOTE = re.compile(r"^\s*>\s?", re.M)
_RULE = re.compile(r"^\s*(?:[-*_=]{3,}|\|?[\s:|-]{3,}\|?)\s*$", re.M)
_EMPHASIS = re.compile(r"(\*\*|__|~~|\*|(?<!\w)_|_(?!\w))")
_INLINE_CODE = re.compile(r"`([^`\n]+)`")
_END = re.compile(r"[.!?:;,…]['\")\]]*$")


def strip_for_speech(text) -> str:
    """Plain words for a voice engine. Code becomes one spoken line, links become their text, structure becomes
    sentences. Idempotent: clean text comes back unchanged."""
    text = str(text or "")
    text = _FENCE.sub("\n" + CODE_LINE + "\n", text)
    text = _IMAGE.sub(" ", text)
    text = _LINK.sub(r"\1", text)
    text = _URL.sub("a link", text)
    text = _HTML.sub(" ", text)
    text = _RULE.sub("", text)
    text = _HEADING.sub("", text)
    text = _QUOTE.sub("", text)
    text = _BULLET.sub("", text)
    text = _INLINE_CODE.sub(r"\1", text)
    text = _EMPHASIS.sub("", text)
    text = text.replace("|", " ")
    # One line per item in a list or heading: end it like a sentence so the voice pauses instead of running on.
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) > 1:
        lines = [line if _END.search(line) else line + "." for line in lines]
    text = " ".join(lines)
    text = re.sub(r"(?:\s*" + re.escape(CODE_LINE) + r"){2,}", " " + CODE_LINE, text)
    return re.sub(r"\s+", " ", text).strip()

