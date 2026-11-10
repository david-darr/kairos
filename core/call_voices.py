"""The account's voice (text-to-speech) engine: the one place every speaker goes through (calls, Open Mic, bots reading
aloud, voice notes, fillers, phone calls to the person and to others). Engines: Kokoro (built in, optional download), a
local OpenAI-compatible server, VoiceStudio (core/voicestudio_voice.py, the person's own install) and ElevenLabs
(core/elevenlabs_voice.py, the person's own key). No engine installs. When VoiceStudio or ElevenLabs fails before any
audio, Kokoro speaks the sentence instead if it is set up; past that the caller's own fallback (the device voice) applies.
"""
import asyncio
import logging
from urllib.parse import urlsplit
import httpx
from core.atomic_io import read_json, write_json_atomic
from core import accounts
from typing import Optional

SETTINGS: Optional[str] = None  # a test can point it at its own file
logger = logging.getLogger(__name__)
PROTOCOLS = ('voicestudio', 'compatible', 'kokoro', 'elevenlabs')

def settings_file():
    return SETTINGS or accounts.path('call_voice.json')

def configuration():
    return read_json(str(settings_file()), {'url':'','protocol':'voicestudio'})

def validate_url(value):
    parsed = urlsplit(value)
    # Literal loopback only: no DNS rebinding, URL credentials or redirects.
    if parsed.scheme not in ('http','https') or parsed.hostname not in ('127.0.0.1','::1','localhost') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('','/'):
        raise ValueError('Use a local voice server origin, such as http://127.0.0.1:8000.')
    if not parsed.port: raise ValueError('Include the voice server port.')
    return value.rstrip('/')

# The built-in Kokoro engine has no server, so it carries a fixed marker where a server address would be. Callers that
# only check "is a voice engine configured" (voice notes) keep working unchanged. ElevenLabs carries its own address.
KOKORO_URL = 'kokoro://local'
ELEVENLABS_URL = 'https://api.elevenlabs.io'

def configure(url, protocol):
    if protocol not in PROTOCOLS: raise ValueError('Unknown voice engine.')
    if protocol == 'elevenlabs':
        from core import voice_keys
        if not voice_keys.has('elevenlabs'): raise ValueError('Save an ElevenLabs key in Settings > Speech first.')
        value = {'url':ELEVENLABS_URL, 'protocol':'elevenlabs'}
        write_json_atomic(str(settings_file()), value)
        return value
    if protocol == 'kokoro':
        from core import kokoro_voice
        ok, reason = kokoro_voice.ready()
        if not ok: raise ValueError(f'Kokoro is not ready yet. {reason}. Use Settings > Speech, or keep the device voice.')
        value = {'url':KOKORO_URL, 'protocol':'kokoro'}
        write_json_atomic(str(settings_file()), value)
        return value
    if protocol == 'voicestudio' and not url:
        from core import voicestudio_voice
        url = voicestudio_voice.DEFAULT_URL
    value = {'url':validate_url(url), 'protocol':protocol}
    write_json_atomic(str(settings_file()), value)
    return value

async def catalog():
    config = configuration()
    if config.get('protocol') == 'kokoro':
        # Unavailable is an answer, not a failure: no voices and the reason, so the dialog falls back to the device voice.
        from core import kokoro_voice
        ok, reason = kokoro_voice.ready()
        found = await asyncio.to_thread(kokoro_voice.voices) if ok else []
        if ok and not found: ok, reason = False, 'Kokoro could not list its voices'
        return {**config, 'voices':found, 'models':[kokoro_voice.NAME] if ok else [], **({} if ok else {'error':f'{reason}. The device voice is used instead.'})}
    if config.get('protocol') == 'elevenlabs':
        from core import elevenlabs_voice, voice_keys
        key = voice_keys.get('elevenlabs')
        if not key: return {**config, 'voices':[], 'models':[], 'error':'No ElevenLabs key is saved. Add one in Settings > Speech.'}
        try: found = await elevenlabs_voice.voices(key)
        except elevenlabs_voice.ElevenLabsError as error: return {**config, 'voices':[], 'models':[], 'error':str(error)}
        return {**config, 'voices':found, 'models':list(elevenlabs_voice.MODELS)}
    if not config['url']: return {**config, 'voices':[], 'models':[]}
    validate_url(config['url'])
    if config.get('protocol') == 'voicestudio':
        from core import voicestudio_voice, voice_keys
        try: found = await voicestudio_voice.catalog(config['url'], voice_keys.get('voicestudio'))
        except voicestudio_voice.VoiceStudioError as error: return {**config, 'voices':[], 'models':[], 'error':str(error)}
        return {**config, **found}
    async with httpx.AsyncClient(timeout=5, trust_env=False, follow_redirects=False) as client:
        models = await client.get(config['url']+'/v1/models'); models.raise_for_status()
        voices = await client.get(config['url']+'/v1/audio/voices'); voices.raise_for_status()
    raw = voices.json(); values = raw.get('voices',raw.get('data',[])) if isinstance(raw,dict) else raw
    result = []
    for item in values[:500]:
        if isinstance(item,str): result.append({'id':item,'name':item})
        elif isinstance(item,dict):
            ident = item.get('id') or item.get('voice_id') or item.get('name')
            if ident: result.append({'id':str(ident), 'name':str(item.get('name') or ident)})
    engines = [str(m['id']) for m in models.json().get('data',[])[:150] if m.get('id')]
    return {**config,'voices':result,'models':engines}

async def pcm(text, model, voice):
    # Whatever reaches a voice engine is plain words: markdown that slipped past the model is stripped here, once, for
    # every caller (calls, bots, voice notes, fillers).
    from core import voice_style
    text = voice_style.strip_for_speech(text)
    if not text: return
    config = configuration()
    if config.get('protocol') not in ('elevenlabs', 'voicestudio'):
        async for item in _engine(config, text, model, voice): yield item
        return
    # A cloud or self-run engine can be down, out of credits or busy. If it fails before any audio, Kokoro (when it is
    # set up) speaks the sentence instead, so a call does not go silent; once audio has started, the error goes up.
    started = False
    try:
        async for item in _engine(config, text, model, voice):
            started = started or 'audio' in item
            yield item
    except Exception as error:
        if started: raise
        from core import kokoro_voice
        if not kokoro_voice.ready()[0]:
            raise ValueError(str(error) if isinstance(error, ValueError) else 'The voice engine could not speak.') from error
        logger.info('voice engine %s failed (%s); Kokoro speaks instead', config.get('protocol'), type(error).__name__)
        async for item in _engine({'url':KOKORO_URL, 'protocol':'kokoro'}, text, kokoro_voice.NAME, kokoro_voice.DEFAULT_VOICE):
            yield item

async def _engine(config, text, model, voice):
    if config.get('protocol') == 'elevenlabs':
        from core import elevenlabs_voice, voice_keys
        key = voice_keys.get('elevenlabs')
        if not key: raise ValueError('No ElevenLabs key is saved. Add one in Settings > Speech.')
        async for item in elevenlabs_voice.stream(text, model, voice, key): yield item
        return
    if config.get('protocol') == 'kokoro':
        from core import kokoro_voice
        # One sentence per call (the speaker already cuts text into sentences and prefetches the next while one plays).
        # Rendered in a worker thread, then handed out in ~100 ms pieces so playback can start on the first piece.
        try: data = await asyncio.to_thread(kokoro_voice.synthesize, text, voice)
        except kokoro_voice.KokoroUnavailable as error: raise ValueError(str(error)) from error
        yield {'sample_rate':kokoro_voice.SAMPLE_RATE}
        for at in range(0, len(data), 4800): yield {'audio':data[at:at+4800]}
        return
    origin = validate_url(config['url'])
    if config['protocol'] == 'voicestudio':
        # The documented OpenAI-compatible speech route, chunked PCM, with the key when VoiceStudio was started with one.
        # (Its /ws/tts socket is an internal dub-preview stream that needs a ticket outside loopback.)
        from core import voicestudio_voice, voice_keys
        async for item in voicestudio_voice.stream(origin, voice_keys.get('voicestudio'), text, model, voice): yield item
        return
    # Kokoro/OpenAI-compatible local engines specify 24 kHz PCM16 mono.
    async with httpx.AsyncClient(timeout=60, trust_env=False, follow_redirects=False) as client:
        async with client.stream('POST',origin+'/v1/audio/speech',json={'input':text,'model':model,'voice':voice,'response_format':'pcm'}) as response:
            response.raise_for_status()
            yield {'sample_rate':24000}
            total = 0
            async for data in response.aiter_bytes():
                total += len(data)
                if total > 8640000: raise ValueError('Voice response exceeded its limit.')
                yield {'audio':data}
