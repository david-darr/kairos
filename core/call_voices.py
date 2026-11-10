"""The account's Voice: the one place every speaker goes through (calls, Open Mic, bots reading aloud, voice notes,
fillers, phone calls to the person and to others, Discord voice). Settings > Speech offers one choice (Locked shape,
David 2026-11-10): Kairos Voice (the default: Kokoro on this computer, or the device voice until Kokoro is ready),
GPT-Live (a realtime call mode; anything read aloud uses Kairos Voice), ElevenLabs (the person's own key,
core/elevenlabs_voice.py), and under More options a Voicebox the person runs (core/voicebox_voice.py) or another local
OpenAI-compatible server. No engine installs. When ElevenLabs or Voicebox fails before any audio, Kokoro speaks the
sentence instead if it is set up; past that the caller's own fallback (the device voice) applies.

Stored per account in call_voice.json as {version: 2, choice, voicebox_url, compatible_url, compatible_voices, notice}.
An older file ({url, protocol}) is migrated on first read so nobody loses a configured engine; a saved VoiceStudio
(removed 2026-11-10) becomes Kairos Voice with a one-line notice.
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
CHOICES = ('kairos', 'gpt_live', 'elevenlabs', 'voicebox', 'compatible')
PROTOCOLS = ('compatible', 'kokoro', 'elevenlabs', 'voicebox')
VOICESTUDIO_NOTICE = 'VoiceStudio is no longer supported, so your voice is now Kairos Voice. Voicebox is under More options.'

def settings_file():
    return SETTINGS or accounts.path('call_voice.json')

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

def _clean(raw):
    raw = raw if isinstance(raw, dict) else {}
    voices = raw.get('compatible_voices')
    return {'version': 2, 'choice': raw.get('choice') if raw.get('choice') in CHOICES else 'kairos',
            'voicebox_url': str(raw.get('voicebox_url') or ''), 'compatible_url': str(raw.get('compatible_url') or ''),
            'compatible_voices': [str(v)[:160] for v in voices[:50] if str(v).strip()] if isinstance(voices, list) else [],
            'notice': str(raw.get('notice') or '')[:300]}

def migrate(raw):
    """An older {url, protocol} file in the new shape. Keeps every engine that still exists; VoiceStudio is gone."""
    protocol, url = raw.get('protocol'), str(raw.get('url') or '')
    value = _clean({})
    if protocol == 'elevenlabs':
        from core import voice_keys
        if voice_keys.has('elevenlabs'): value['choice'] = 'elevenlabs'
    elif protocol == 'compatible' and url:
        value.update(choice='compatible', compatible_url=url)
    elif protocol == 'voicestudio':
        from core import voice_keys
        voice_keys.clear('voicestudio')          # its OMNIVOICE_API_KEY is no use to anything now
        if url: value['notice'] = VOICESTUDIO_NOTICE
    return value

def stored():
    raw = read_json(str(settings_file()), None)
    if raw is None: return _clean({})
    if isinstance(raw, dict) and raw.get('version') == 2: return _clean(raw)
    value = migrate(raw if isinstance(raw, dict) else {})
    write_json_atomic(str(settings_file()), value)
    return value

def _save(**changes):
    value = _clean({**stored(), **changes})
    write_json_atomic(str(settings_file()), value)
    return value

def choice():
    return stored()['choice']

def set_choice(value, url=''):
    """Make `value` the account's Voice. Checks only what this module knows (keys, addresses); the route checks GPT-Live."""
    if value not in CHOICES: raise ValueError('Unknown voice.')
    if value == 'elevenlabs':
        from core import voice_keys
        if not voice_keys.has('elevenlabs'): raise ValueError('Save an ElevenLabs key in Settings > Speech first.')
    changes = {'choice': value, 'notice': ''}
    if value == 'voicebox':
        from core import voicebox_voice
        changes['voicebox_url'] = validate_url(url or stored()['voicebox_url'] or voicebox_voice.DEFAULT_URL)
    if value == 'compatible':
        address = url or stored()['compatible_url']
        if not address: raise ValueError('Type the voice server address first.')
        changes['compatible_url'] = validate_url(address)
    _save(**changes)
    return configuration()

def set_compatible_voices(names):
    _save(compatible_voices=[n.strip() for n in names if n.strip()])

def dismiss_notice():
    _save(notice='')

def configuration():
    """The engine behind the Voice, in the shape every speaker uses: {'choice', 'url', 'protocol'} (url '' = no engine)."""
    value = stored()
    current = value['choice']
    if current == 'elevenlabs': return {'choice':current, 'url':ELEVENLABS_URL, 'protocol':'elevenlabs'}
    if current == 'voicebox':
        from core import voicebox_voice
        return {'choice':current, 'url':value['voicebox_url'] or voicebox_voice.DEFAULT_URL, 'protocol':'voicebox'}
    if current == 'compatible': return {'choice':current, 'url':value['compatible_url'], 'protocol':'compatible'}
    # Kairos Voice and GPT-Live: Kokoro when it is ready, else no engine (each caller then uses the device voice).
    # GPT-Live speaks for itself in calls; everything read aloud outside a call uses Kairos Voice.
    from core import kokoro_voice
    return {'choice':current, 'url':KOKORO_URL if kokoro_voice.ready()[0] else '', 'protocol':'kokoro'}

def configure(url, protocol):
    """The older per-engine call (PUT /api/agent-calls/voices): the matching Voice choice."""
    if protocol not in PROTOCOLS: raise ValueError('Unknown voice engine.')
    if protocol == 'kokoro':
        from core import kokoro_voice
        ok, reason = kokoro_voice.ready()
        if not ok: raise ValueError(f'Kokoro is not ready yet. {reason}. Use Settings > Speech, or keep the device voice.')
        return set_choice('kairos')
    return set_choice(protocol, url)

async def _compatible_catalog(config):
    """A local OpenAI-compatible server. One that does not list its voices (GET /v1/audio/voices answers 404, as
    Voicebox's own OpenAI-compatible router does) uses the voice names typed in More options instead of failing."""
    typed = [{'id':name, 'name':name} for name in stored()['compatible_voices']]
    async with httpx.AsyncClient(timeout=5, trust_env=False, follow_redirects=False) as client:
        models = await client.get(config['url']+'/v1/models'); models.raise_for_status()
        voices = await client.get(config['url']+'/v1/audio/voices')
    engines = [str(m['id']) for m in models.json().get('data',[])[:150] if isinstance(m, dict) and m.get('id')]
    if voices.status_code in (404, 405):
        if not typed:
            return {**config, 'voices':[], 'models':engines, 'error':'This voice server does not list its voices. Type a voice name in Settings > Speech > More options.'}
        return {**config, 'voices':typed, 'models':engines}
    voices.raise_for_status()
    raw = voices.json(); values = raw.get('voices',raw.get('data',[])) if isinstance(raw,dict) else raw
    result = []
    for item in values[:500]:
        if isinstance(item,str): result.append({'id':item,'name':item})
        elif isinstance(item,dict):
            ident = item.get('id') or item.get('voice_id') or item.get('name')
            if ident: result.append({'id':str(ident), 'name':str(item.get('name') or ident)})
    return {**config,'voices':result or typed,'models':engines}

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
    if config.get('protocol') == 'voicebox':
        from core import voicebox_voice
        try: found = await voicebox_voice.catalog(config['url'])
        except voicebox_voice.VoiceboxError as error: return {**config, 'voices':[], 'models':[], 'error':str(error)}
        return {**config, **found}
    return await _compatible_catalog(config)

FALLS_BACK = ('elevenlabs', 'voicebox')

async def pcm(text, model, voice):
    # Whatever reaches a voice engine is plain words: markdown that slipped past the model is stripped here, once, for
    # every caller (calls, bots, voice notes, fillers).
    from core import voice_style
    text = voice_style.strip_for_speech(text)
    if not text: return
    config = configuration()
    if config.get('protocol') not in FALLS_BACK:
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
    if config['protocol'] == 'voicebox':
        # Whole-clip renders, one sentence per request; the caller fetches the next sentence while one plays.
        from core import voicebox_voice
        async for item in voicebox_voice.stream(origin, text, model, voice): yield item
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
