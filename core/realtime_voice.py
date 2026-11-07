"""Realtime speech-to-speech providers (build spec 6b, Track A): one adapter per provider.

An adapter knows only a provider's WIRE FORMAT: where to connect, how to log in, the first messages, how to wrap
audio and tool results, and how to read what comes back as a few NORMALIZED events. Sessions (services/realtime_session.py)
and the phone bridge sit on top and never see a provider's own message names. Nothing here opens a socket.

Normalized events (dicts, `type`):
  ready                      the provider accepted the session
  audio        pcm, item_id  PCM16 mono at `adapter.rate_out`
  speech_started             the person started talking: stop playing NOW (server VAD / semantic VAD decide this)
  assistant_text  delta      what the model is saying (transcript of its audio)
  user_text       delta      what the person said
  tool_call    call_id, name, args
  response_started / turn_done
  error        message

UNVERIFIED WITHOUT REAL KEYS: every message name below was written from the providers' public docs and aggregator
docs (OpenAI Realtime GA, xAI's OpenAI-compatible realtime, Google's Gemini Live WebSocket guide). The mock-server
tests prove our own framing is consistent, not that the providers accept it. xAI's model id, voices and audio rate and
Gemini's model id, push-text message and tool shape are the likeliest to need a one-line fix on first real use.
"""
import base64
import json
from typing import Optional

TOOL_NAME = "do_work"
TOOL_DESCRIPTION = ("Hand a task to the assistant's own full model and tools (research, files, code, apps, anything that "
                    "needs more than conversation). It returns at once; the result is announced to you when it is done. "
                    "Say a short acknowledgement while it runs. Never claim the work is finished until it is announced.")
TOOL_PARAMETERS = {"type": "object", "properties": {
    "title": {"type": "string", "description": "Three to six words naming the task."},
    "request": {"type": "string", "description": "What to do, with the details the person gave, in full sentences."}},
    "required": ["title", "request"]}

REALTIME_PROMPT = ("You are the conversational voice of this Kairos agent, speaking aloud in real time. Keep answers short and "
                   "natural, a sentence or two, no lists, no markdown. You have one tool, do_work: call it for anything that "
                   "needs research, files, code, apps or other actions, then say a brief acknowledgement. Never invent "
                   "results. Work continues independently when speech is interrupted; finished work is announced to you "
                   "and you then say the outcome plainly.")

BASE_OVERRIDE: dict = {}          # tests: provider name -> a ws://127.0.0.1:port base standing in for the real host


class Event(dict):
    def __init__(self, type_, **kwargs):
        super().__init__(type=type_, **kwargs)


def _json(raw) -> Optional[dict]:
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("utf-8", "replace")
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _b64(pcm: bytes) -> str:
    return base64.b64encode(pcm).decode()


class Adapter:
    name = ""
    label = ""
    host_hints: tuple = ()
    rate_in = 24000                 # PCM16 rate the provider wants from us
    rate_out = 24000                # PCM16 rate it speaks at
    price_per_minute = 0.06         # USD, an ESTIMATE shown on the call screen (spec: about $0.05 to $0.08)
    default_model = ""
    voices: tuple = ()
    default_voice = ""
    verified = False                # nothing here has met a real provider yet
    truncates = False               # accepts "the person only heard this much of the reply"

    def url(self, model: str) -> str:
        raise NotImplementedError

    def headers(self, key: str) -> dict:
        return {"Authorization": f"Bearer {key}"}

    def setup(self, instructions: str, voice: str, model: str) -> list:
        raise NotImplementedError

    def audio(self, pcm16: bytes) -> str:
        raise NotImplementedError

    def tool_result(self, call_id: str, name: str, output: str) -> list:
        raise NotImplementedError

    def inject(self, text: str) -> list:
        """Messages that make the model say something about `text` now (finished work)."""
        raise NotImplementedError

    def truncate(self, item_id: str, played_ms: int) -> list:
        return []

    def parse(self, raw) -> list:
        raise NotImplementedError

    def describe(self) -> dict:
        return {"provider": self.name, "label": self.label, "default_model": self.default_model, "voices": list(self.voices),
                "default_voice": self.default_voice, "price_per_minute": self.price_per_minute, "verified": self.verified}


class OpenAIRealtime(Adapter):
    name = "openai"
    label = "OpenAI Realtime"
    host_hints = ("api.openai.com",)
    default_model = "gpt-realtime"
    voices = ("marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse")
    default_voice = "marin"
    price_per_minute = 0.08
    truncates = True
    endpoint = "wss://api.openai.com/v1/realtime"
    turn_detection = {"type": "semantic_vad"}

    def url(self, model: str) -> str:
        return f"{BASE_OVERRIDE.get(self.name) or self.endpoint}?model={model or self.default_model}"

    def setup(self, instructions, voice, model):
        session = {"type": "realtime", "instructions": instructions, "output_modalities": ["audio"],
                   "audio": {"input": {"format": {"type": "audio/pcm", "rate": self.rate_in},
                                       "turn_detection": self.turn_detection,
                                       "transcription": {"model": "gpt-4o-mini-transcribe"}},
                             "output": {"format": {"type": "audio/pcm", "rate": self.rate_out}, "voice": voice or self.default_voice}},
                   "tools": [{"type": "function", "name": TOOL_NAME, "description": TOOL_DESCRIPTION, "parameters": TOOL_PARAMETERS}],
                   "tool_choice": "auto"}
        return [{"type": "session.update", "session": session}]

    def audio(self, pcm16):
        return json.dumps({"type": "input_audio_buffer.append", "audio": _b64(pcm16)})

    def tool_result(self, call_id, name, output):
        return [{"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": call_id, "output": output}},
                {"type": "response.create"}]

    def inject(self, text):
        return [{"type": "conversation.item.create", "item": {"type": "message", "role": "system",
                                                               "content": [{"type": "input_text", "text": text}]}},
                {"type": "response.create"}]

    def truncate(self, item_id, played_ms):
        if not item_id:
            return []
        return [{"type": "conversation.item.truncate", "item_id": item_id, "content_index": 0, "audio_end_ms": max(0, round(played_ms))}]

    def parse(self, raw):
        message = _json(raw)
        if not message:
            return []
        kind = message.get("type", "")
        if kind == "session.updated":
            return [Event("ready")]
        if kind in ("response.output_audio.delta", "response.audio.delta"):
            try:
                pcm = base64.b64decode(message.get("delta") or "")
            except ValueError:
                return []
            return [Event("audio", pcm=pcm, item_id=message.get("item_id"))]
        if kind in ("response.output_audio_transcript.delta", "response.audio_transcript.delta"):
            return [Event("assistant_text", delta=message.get("delta") or "", item_id=message.get("item_id"))]
        if kind == "conversation.item.input_audio_transcription.completed":
            return [Event("user_text", delta=message.get("transcript") or "")]
        if kind == "input_audio_buffer.speech_started":
            return [Event("speech_started")]
        if kind == "response.created":
            return [Event("response_started")]
        if kind == "response.done":
            return [Event("turn_done", usage=(message.get("response") or {}).get("usage"))]
        if kind == "response.function_call_arguments.done":
            args = _json(message.get("arguments") or "{}") or {}
            return [Event("tool_call", call_id=message.get("call_id") or "", name=message.get("name") or "", args=args)]
        if kind == "error":
            return [Event("error", message=str((message.get("error") or {}).get("message") or "Provider error"))]
        return []


class XAIRealtime(OpenAIRealtime):
    """xAI Grok Voice Agent API: an OpenAI-compatible realtime socket (docs and LiteLLM's xAI realtime page). UNVERIFIED:
    the model id, voice names, audio rate and whether it honours item truncation are taken from those docs, not tried."""
    name = "xai"
    label = "xAI Grok Voice"
    host_hints = ("api.x.ai",)
    default_model = "grok-voice-latest"
    voices = ("ara", "rex", "sal", "eve", "leo")
    default_voice = "ara"
    price_per_minute = 0.05
    endpoint = "wss://api.x.ai/v1/realtime"
    turn_detection = {"type": "server_vad"}


class GeminiLive(Adapter):
    """Google Gemini Live: BidiGenerateContent WebSocket, setup message first, 16 kHz PCM in, 24 kHz PCM out, tool calls
    answered with a toolResponse. The server itself stops generating when the person talks (`interrupted`); there is no
    truncate message. UNVERIFIED: model id, the realtimeInput text push, tool-call shape on the 3.1 preview."""
    name = "gemini"
    label = "Google Gemini Live"
    host_hints = ("generativelanguage.googleapis.com",)
    rate_in = 16000
    rate_out = 24000
    default_model = "gemini-3.1-flash-live-preview"
    voices = ("Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr")
    default_voice = "Puck"
    price_per_minute = 0.06
    endpoint = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

    def url(self, model):
        return BASE_OVERRIDE.get(self.name) or self.endpoint

    def headers(self, key):
        return {"x-goog-api-key": key}          # a header, so the key is never part of a URL that could be logged

    def setup(self, instructions, voice, model):
        name = model or self.default_model
        return [{"setup": {
            "model": name if name.startswith("models/") else f"models/{name}",
            "generationConfig": {"responseModalities": ["AUDIO"],
                                 "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice or self.default_voice}}}},
            "systemInstruction": {"parts": [{"text": instructions}]},
            "tools": [{"functionDeclarations": [{"name": TOOL_NAME, "description": TOOL_DESCRIPTION, "parameters": TOOL_PARAMETERS}]}],
            "realtimeInputConfig": {"automaticActivityDetection": {}},
            "inputAudioTranscription": {}, "outputAudioTranscription": {}}}]

    def audio(self, pcm16):
        return json.dumps({"realtimeInput": {"audio": {"data": _b64(pcm16), "mimeType": f"audio/pcm;rate={self.rate_in}"}}})

    def tool_result(self, call_id, name, output):
        return [{"toolResponse": {"functionResponses": [{"id": call_id, "name": name, "response": {"output": output}}]}}]

    def inject(self, text):
        return [{"realtimeInput": {"text": text}}]

    def parse(self, raw):
        message = _json(raw)
        if not message:
            return []
        events = []
        if "setupComplete" in message:
            events.append(Event("ready"))
        content = message.get("serverContent") or {}
        for part in (content.get("modelTurn") or {}).get("parts") or []:
            data = part.get("inlineData") or {}
            if data.get("data") and str(data.get("mimeType", "")).startswith("audio/"):
                try:
                    events.append(Event("audio", pcm=base64.b64decode(data["data"]), item_id=None))
                except ValueError:
                    pass
        if (content.get("inputTranscription") or {}).get("text"):
            events.append(Event("user_text", delta=content["inputTranscription"]["text"]))
        if (content.get("outputTranscription") or {}).get("text"):
            events.append(Event("assistant_text", delta=content["outputTranscription"]["text"], item_id=None))
        if content.get("interrupted"):
            events.append(Event("speech_started", provider_stopped=True))
        if content.get("turnComplete"):
            events.append(Event("turn_done", usage=message.get("usageMetadata")))
        for call in (message.get("toolCall") or {}).get("functionCalls") or []:
            events.append(Event("tool_call", call_id=call.get("id") or "", name=call.get("name") or "", args=call.get("args") or {}))
        if message.get("error"):
            events.append(Event("error", message=str((message["error"] or {}).get("message") or "Provider error")))
        return events


ADAPTERS = {a.name: a for a in (OpenAIRealtime(), XAIRealtime(), GeminiLive())}


def adapter(name: str) -> Adapter:
    if name not in ADAPTERS:
        raise ValueError("Unknown realtime voice provider.")
    return ADAPTERS[name]


def provider_for_url(base_url: str) -> Optional[str]:
    """The provider a connection's address belongs to, by official host only."""
    from urllib.parse import urlparse
    host = (urlparse(base_url or "").hostname or "").lower()
    for item in ADAPTERS.values():
        if host in item.host_hints:
            return item.name
    return None


def cost_estimate(provider: str, seconds: float) -> float:
    return round(max(0.0, seconds) / 60 * adapter(provider).price_per_minute, 4)
