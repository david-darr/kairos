"""Discord voice probe: does Kairos hear you in a Discord voice channel, and can you hear it?

Joins the voice channel set for one of your Kairos Discord bots (Settings > Channels), plays two short beeps, then
listens for a while and reports, for your audio only: how many frames arrived, how many were end-to-end encrypted
(DAVE), how many came before their key (waiting), how many were opened, how many decoded as Opus, and the first error
of each kind. It prints every DAVE key-change event as it happens, and waits for the bot's voice to be encryptable
before the beeps. It goes through the same
connection code a real call uses (services/discord_voice_transport.RealTransport), and nothing is transcribed, stored
or sent anywhere. Uses the bot's saved token from the profile (never printed). Run it yourself, while no Discord voice
call with that bot is live (a bot has one voice connection per server):

    set JARVIS_DATA_DIR=C:\\Users\\David\\AppData\\Roaming\\JARVIS-dev\\data
    .venv\\Scripts\\python.exe -X utf8 scripts\\discord_voice_probe.py [--bot NAME_OR_ID] [--seconds 30]

Then join the channel and talk for a few seconds. Exit code 0: your audio decoded. 1: it did not. 2: not set up.
"""
import argparse
import asyncio
import logging
import math
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def beep_frames(codec, audio, seconds=0.4, freq=660.0) -> list:
    """Opus packets of a short tone (48 kHz stereo, 20 ms each)."""
    import numpy as np
    frames = []
    for index in range(int(seconds / audio.FRAME_SECONDS)):
        n = np.arange(index * audio.FRAME_SAMPLES, (index + 1) * audio.FRAME_SAMPLES)
        wave = (np.sin(2 * math.pi * freq * n / audio.DISCORD_RATE) * 0.25 * 32767).astype("<i2")
        frames.append(codec.encode(np.repeat(wave, 2).tobytes()))
    return frames


class Tally:
    """What happened to the person's frames, step by step, with the first error of each kind."""

    def __init__(self, transport, codec, audio):
        self.transport, self.codec, self.audio = transport, codec, audio
        self.decoder = codec.new_decoder()
        self.counts = Counter()
        self.errors = {}

    def frame(self, payload: bytes) -> None:
        self.counts["frames"] += 1
        if self.audio.is_dave_frame(payload):
            self.counts["dave_encrypted"] += 1
        try:
            opus = self.transport.decrypt(self.transport.linked_user, payload)
        except Exception as error:
            kind = "waiting_for_key" if getattr(error, "pending", False) else "could_not_open"
            self.counts[kind] += 1
            self.errors.setdefault(kind, f"{type(error).__name__}: {error}")
            return
        self.counts["opened"] += 1
        try:
            pcm = self.decoder.decode(opus)
        except Exception as error:
            self.counts["opus_failed"] += 1
            self.errors.setdefault("opus", f"{type(error).__name__}: {error}")
            self.decoder = self.codec.new_decoder()
            return
        self.counts["decoded"] += 1
        if pcm and max(abs(int.from_bytes(pcm[i:i + 2], "little", signed=True)) for i in range(0, min(len(pcm), 3840), 2)) > 500:
            self.counts["decoded_with_sound"] += 1

    def report(self) -> str:
        keys = ("frames", "dave_encrypted", "waiting_for_key", "opened", "could_not_open", "decoded", "opus_failed",
                "decoded_with_sound")
        lines = [f"  {key.replace('_', ' ')}: {self.counts[key]}" for key in keys]
        lines += [f"  first {kind} error: {text}" for kind, text in self.errors.items()]
        return "\n".join(lines)


async def probe(bot: dict, token: str, seconds: float) -> int:
    import discord
    from core import discord_voice_audio as audio
    from services.discord_voice_transport import RealTransport

    outcome = {"code": 2}
    client = discord.Client(intents=discord.Intents.default())

    @client.event
    async def on_ready():
        try:
            outcome["code"] = await session(client)
        except Exception as error:
            print(f"probe failed: {type(error).__name__}: {error}")
            outcome["code"] = 2
        finally:
            await client.close()

    async def session(client) -> int:
        channel = client.get_channel(int(bot["voice_channel_id"])) or await client.fetch_channel(int(bot["voice_channel_id"]))
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        transport = RealTransport(channel, str(bot["allowed_user_id"]), loop)
        await transport.connect(lambda event: loop.call_soon_threadsafe(queue.put_nowait, event))
        codec = audio.OpusCodec()
        tally = Tally(transport, codec, audio)
        print(f"Joined #{channel.name}. Connection: {transport.status()}")
        print(f"Join the channel and talk for a few seconds. Listening for {seconds:.0f} s.")
        beeped = False
        started = loop.time()
        last_print = started
        try:
            while loop.time() - started < seconds:
                if not beeped and str(bot["allowed_user_id"]) in transport.members():
                    beeped = True
                    print("You are in the channel. Waiting (up to 10 s) until the bot's voice can be encrypted...")
                    for _ in range(200):
                        if transport.ready_to_speak():
                            break
                        await asyncio.sleep(0.05)
                    print(f"Connection now: {transport.status()}")
                    if not transport.ready_to_speak():
                        print("The bot's voice could not be encrypted: you will not hear the beeps.")
                    print("Playing two beeps now (did you hear them?).")
                    for _ in range(2):
                        for packet in beep_frames(codec, audio):
                            transport.send(packet)
                        for _ in range(15):
                            transport.send(audio.OPUS_SILENCE)
                    print(f"Connection while sending: {transport.status()}")
                try:
                    event = await asyncio.wait_for(queue.get(), 0.5)
                except asyncio.TimeoutError:
                    event = None
                if event and event[0] == "opus":
                    tally.frame(event[2])
                if not transport.receiving():
                    print("Receiving stopped and could not be restarted.")
                    break
                if loop.time() - last_print >= 5:
                    last_print = loop.time()
                    print(f"  ... {tally.counts['frames']} frames, {tally.counts['decoded']} decoded")
        finally:
            status = transport.status()
            await transport.disconnect()
        print(f"\nConnection at the end: {status}")
        print("Your audio:\n" + tally.report())
        if not tally.counts["frames"]:
            print("\nVerdict: none of your audio arrived (did you join and talk?).")
            return 1
        if tally.counts["decoded"]:
            print("\nVerdict: your audio decodes. Kairos can hear you in Discord.")
            return 0
        print("\nVerdict: your audio arrived but could not be decoded. Send this output to Kairos.")
        return 1

    await client.start(token)
    return outcome["code"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--bot", help="the Discord bot's name or id (default: the first with a voice channel)")
    parser.add_argument("--seconds", type=float, default=30.0)
    args = parser.parse_args()
    if not os.environ.get("JARVIS_DATA_DIR"):
        print("Set JARVIS_DATA_DIR to the profile's data folder first (see the top of this file).")
        return 2
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("services.discord_voice_transport").setLevel(logging.INFO)   # with every DAVE event (.dave)
    from core import discord_bots_store, discord_voice_audio as audio
    missing = audio.missing_requirements()
    if missing:
        print("Not installed: " + ", ".join(missing))
        return 2
    bots = [bot for bot in discord_bots_store.list_bots() if bot.get("voice_channel_id") and bot.get("allowed_user_id")]
    if args.bot:
        bots = [bot for bot in bots if args.bot in (bot.get("id"), bot.get("name"))]
    if not bots:
        print("No Discord bot with a voice channel and an allowed user (Settings > Channels).")
        return 2
    bot = bots[0]
    token = discord_bots_store.resolve_token(bot["id"])
    if not token:
        print("That bot has no saved token in this profile.")
        return 2
    print(f"Bot: {bot.get('name')} ({bot['id']}), voice channel {bot['voice_channel_id']}")
    return asyncio.run(probe(bot, token, args.seconds))


if __name__ == "__main__":
    sys.exit(main())
