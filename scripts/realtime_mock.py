"""A mock realtime provider for tests: a WebSocket server on 127.0.0.1 (loopback only, never the network) that speaks just
enough of each provider's wire format to start a session, records everything it is sent, and plays back scripted events.
Tests point core.realtime_voice.BASE_OVERRIDE at it, so nothing ever reaches OpenAI, xAI or Google.
"""
import asyncio
import base64
import json
import time

from websockets.asyncio.server import serve


class MockRealtime:
    def __init__(self, provider: str, auto_ready: bool = True):
        self.provider, self.auto_ready = provider, auto_ready
        self.received: list = []
        self.headers: dict = {}
        self.path = ""
        self.ws = None
        self.connected = asyncio.Event()
        self.server = None
        self.url = ""

    async def start(self):
        self.server = await serve(self._handler, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}"
        return self

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()

    async def _handler(self, ws):
        self.ws, self.path = ws, ws.request.path
        self.headers = {k.lower(): v for k, v in ws.request.headers.items()}
        self.connected.set()
        try:
            async for raw in ws:
                message = json.loads(raw)
                self.received.append(message)
                if self.auto_ready and (message.get("type") == "session.update" or "setup" in message):
                    await self.push({"type": "session.updated"} if "setup" not in message else {"setupComplete": {}})
        except Exception:
            pass

    async def push(self, message: dict):
        await self.ws.send(json.dumps(message))

    async def push_bytes(self, message: dict):
        await self.ws.send(json.dumps(message).encode())

    def of_type(self, kind: str) -> list:
        return [m for m in self.received if m.get("type") == kind]

    def with_key(self, key: str) -> list:
        return [m for m in self.received if key in m]

    async def wait_for(self, predicate, timeout: float = 4.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            found = [m for m in self.received if predicate(m)]
            if found:
                return found[-1]
            await asyncio.sleep(0.01)
        raise AssertionError(f"the mock provider was never sent the expected message; got {[list(m)[:2] for m in self.received][-8:]}")


def b64(pcm: bytes) -> str:
    return base64.b64encode(pcm).decode()


# -- scripted provider events ------------------------------------------------------------------------------

def openai_audio(pcm: bytes, item_id: str = "item1") -> dict:
    return {"type": "response.output_audio.delta", "item_id": item_id, "content_index": 0, "delta": b64(pcm)}


def openai_text(delta: str, item_id: str = "item1") -> dict:
    return {"type": "response.output_audio_transcript.delta", "item_id": item_id, "delta": delta}


def openai_tool(call_id: str, args: dict, name: str = "do_work") -> dict:
    return {"type": "response.function_call_arguments.done", "call_id": call_id, "name": name, "arguments": json.dumps(args)}


def gemini_audio(pcm: bytes) -> dict:
    return {"serverContent": {"modelTurn": {"parts": [{"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": b64(pcm)}}]}}}
