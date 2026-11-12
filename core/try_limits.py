"""Limits on wrong tries: sign-in (routes/auth_routes.py) and phone pairing (core/phone_devices.py).

A TryLimit counts wrong tries per key inside a sliding window. It only ever counts failures; a right
answer neither adds nor clears, so a person who holds one valid account cannot reset the count they are
running up against another. Counts live in memory: a restart clears them, which costs an attacker a
restart of someone else's computer.

Keys the caller builds from outside input (an address, a user name) are hashed here, so a long or odd
value costs the same as a short one, and the table is capped: the oldest entries go first.
"""
import hashlib
import ipaddress
import threading
import time
from typing import Optional

MAX_KEYS = 20000


def address_key(host: Optional[str]) -> str:
    """The key for a caller's network address. An IPv6 caller is counted by its /64, because one device
    (or one home line) holds a whole /64 and could otherwise use a new address for every try. A caller
    with no address at all shares one key, so it is limited rather than exempt."""
    try:
        address = ipaddress.ip_address((host or "").split("%")[0])
    except ValueError:
        return "addr:unknown"
    if address.version == 6:
        mapped = address.ipv4_mapped
        if mapped is not None:
            return f"addr:{mapped}"
        return f"addr:{ipaddress.ip_network((address, 64), strict=False).network_address}/64"
    return f"addr:{address}"


def is_loopback(host: Optional[str]) -> bool:
    try:
        address = ipaddress.ip_address((host or "").split("%")[0])
    except ValueError:
        return False
    return address.is_loopback or bool(address.version == 6 and address.ipv4_mapped and address.ipv4_mapped.is_loopback)


class TryLimit:
    def __init__(self, limit: int, window_seconds: float) -> None:
        self.limit, self.window = limit, window_seconds
        self._tries: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _key(key: str) -> str:
        return hashlib.sha256(str(key).encode("utf-8", "replace")).hexdigest()[:32]

    def _live(self, key: str, now: float) -> list[float]:
        tries = [t for t in self._tries.get(key, ()) if t > now - self.window]
        if tries:
            self._tries[key] = tries
        else:
            self._tries.pop(key, None)
        return tries

    def wait(self, key: str, now: Optional[float] = None) -> int:
        """Seconds until this key may try again; 0 when it may try now."""
        now = time.time() if now is None else now
        with self._lock:
            tries = self._live(self._key(key), now)
            if len(tries) < self.limit:
                return 0
            return max(1, int(tries[-self.limit] + self.window - now) + 1)

    def add(self, key: str, now: Optional[float] = None) -> int:
        """Record one wrong try; answers how many are now inside the window."""
        now = time.time() if now is None else now
        with self._lock:
            hashed = self._key(key)
            tries = self._live(hashed, now)
            tries.append(now)
            self._tries[hashed] = tries[-self.limit:]
            if len(self._tries) > MAX_KEYS:
                for old in sorted(self._tries, key=lambda k: self._tries[k][-1])[:len(self._tries) - MAX_KEYS]:
                    self._tries.pop(old, None)
            return len(self._tries[hashed])

    def clear(self) -> None:
        with self._lock:
            self._tries.clear()
