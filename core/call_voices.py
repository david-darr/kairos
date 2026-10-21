"""Independent adapters to installed local voice servers. No engine installs."""
import asyncio
import json
from urllib.parse import urlsplit
import httpx
from websockets.asyncio.client import connect
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from pathlib import Path

SETTINGS = Path(DATA_DIR) / 'call_voice.json'

def configuration():
    return read_json(str(SETTINGS), {'url':'','protocol':'voicestudio'})

def validate_url(value):
    parsed = urlsplit(value)
    # Literal loopback only: no DNS rebinding, URL credentials or redirects.
    if parsed.scheme not in ('http','https') or parsed.hostname not in ('127.0.0.1','::1','localhost') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('','/'):
        raise ValueError('Use a local voice server origin, such as http://127.0.0.1:8000.')
    if not parsed.port: raise ValueError('Include the voice server port.')
    return value.rstrip('/')

def configure(url, protocol):
    value = {'url':validate_url(url), 'protocol':protocol}
    write_json_atomic(str(SETTINGS), value)
    return value

async def catalog():
    config = configuration()
    if not config['url']: return {**config, 'voices':[], 'models':[]}
    validate_url(config['url'])
    async with httpx.AsyncClient(timeout=5, trust_env=False, follow_redirects=False) as client:
        models = await client.get(config['url']+'/v1/models'); models.raise_for_status()
        voices = await client.get(config['url']+'/v1/audio/voices'); voices.raise_for_status()
    raw = voices.json(); values = raw.get('voices',raw.get('data',[])) if isinstance(raw,dict) else raw
    result = [{'id':'default','name':'Engine default'}] if config['protocol']=='voicestudio' else []
    for item in values[:500]:
        if isinstance(item,str): result.append({'id':item,'name':item})
        elif isinstance(item,dict):
            if config['protocol']=='voicestudio' and item.get('type')=='openai_alias': continue
            ident = item.get('id') or item.get('voice_id') or item.get('name')
            if ident: result.append({'id':str(ident), 'name':str(item.get('name') or ident)})
    engines = [str(m['id']) for m in raw.get('engines',[]) if m.get('available') and m.get('routing_status')!='unavailable'] if config['protocol']=='voicestudio' and isinstance(raw,dict) else [str(m['id']) for m in models.json().get('data',[])[:150] if m.get('id')]
    return {**config,'voices':result,'models':engines}

async def pcm(text, model, voice):
    config = configuration(); origin = validate_url(config['url'])
    if config['protocol'] == 'voicestudio':
        # VoiceStudio's WebSocket supplies the real engine rate, unlike its
        # compatible endpoint which buffers a whole render before delivery.
        url = origin.replace('https://','wss://').replace('http://','ws://')+'/ws/tts'
        async with connect(url, open_timeout=8, max_size=2**21, proxy=None) as socket:
            await socket.send(json.dumps({'text':text,'engine':model,'voice':None if voice=='default' else voice}))
            total = 0
            while True:
                message = await asyncio.wait_for(socket.recv(), timeout=60)
                if isinstance(message,bytes):
                    total += len(message)
                    if total > 24000*2*180: raise ValueError('Voice response exceeded its limit.')
                    yield {'audio':message}
                else:
                    item = json.loads(message)
                    if item.get('type') == 'error': raise ValueError('Voice engine could not speak. Check its installation and selected voice.')
                    if item.get('type') == 'start':
                        rate = item.get('sample_rate')
                        if item.get('channels') != 1 or item.get('format') != 'pcm16' or not isinstance(rate,int) or not 8000<=rate<=96000:
                            raise ValueError('Unsupported voice audio format.')
                        yield {'sample_rate':rate}
                    if item.get('type') == 'done': break
    else:
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
