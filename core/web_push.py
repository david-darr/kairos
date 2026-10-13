"""RFC 8291 encryption and RFC 8292 VAPID, using the shipped cryptography library.

Only browser push providers are destinations; enrollment is not an arbitrary
outbound HTTP capability. Never follow redirects or include cookies in delivery.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import struct
import time
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def unb64(value: str) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", value):
        raise ValueError("Invalid push key")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def public_key(key) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962,
                                        serialization.PublicFormat.UncompressedPoint)


def validate(subscription: dict) -> dict:
    endpoint = subscription.get("endpoint", "")
    if not isinstance(endpoint, str) or len(endpoint) > 2048:
        raise ValueError("Invalid push endpoint")
    url = urlsplit(endpoint)
    # Exact provider domains prevent localhost/private-IP and DNS-rebinding
    # enrollment, including lookalike suffixes. Add providers explicitly.
    host = url.hostname or ""
    allowed = host in {"web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"}
    allowed |= bool(re.fullmatch(r"[a-z0-9-]+\.notify\.windows\.com", host))
    if (not allowed or url.scheme != "https" or url.port not in (None, 443)
            or url.username or url.password or url.fragment or not url.path.startswith("/")):
        raise ValueError("This browser's push provider is not supported")
    keys = subscription.get("keys") or {}
    ua, auth = unb64(keys.get("p256dh")), unb64(keys.get("auth"))
    if len(ua) != 65 or len(auth) != 16:
        raise ValueError("Invalid push key length")
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua)
    return {"endpoint": endpoint, "keys": {"p256dh": b64(ua), "auth": b64(auth)}}


def encrypt(subscription: dict, payload: bytes, *, sender=None, salt=None) -> bytes:
    if len(payload) > 3993:
        raise ValueError("Push payload is too large")
    sender = sender or ec.generate_private_key(ec.SECP256R1())
    salt = salt or os.urandom(16)
    ua = unb64(subscription["keys"]["p256dh"])
    auth = unb64(subscription["keys"]["auth"])
    shared = sender.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua))
    as_public = public_key(sender)
    mac = lambda key, data: hmac.new(key, data, hashlib.sha256).digest()
    prk_key = mac(auth, shared)
    ikm = mac(prk_key, b"WebPush: info\0" + ua + as_public + b"\x01")
    prk = mac(salt, ikm)
    cek = mac(prk, b"Content-Encoding: aes128gcm\0\x01")[:16]
    nonce = mac(prk, b"Content-Encoding: nonce\0\x01")[:12]
    return salt + struct.pack("!IB", 4096, 65) + as_public + AESGCM(cek).encrypt(nonce, payload + b"\x02", None)


def authorization(private: str, endpoint: str, subject: str) -> str:
    key = ec.derive_private_key(int.from_bytes(unb64(private), "big"), ec.SECP256R1())
    url = urlsplit(endpoint)
    audience = f"{url.scheme}://{url.hostname}" + (f":{url.port}" if url.port and url.port != 443 else "")
    encode = lambda value: b64(json.dumps(value, separators=(",", ":")).encode())
    token = encode({"typ": "JWT", "alg": "ES256"}) + "." + encode({
        "aud": audience, "exp": int(time.time()) + 3600, "sub": subject})
    r, s = utils.decode_dss_signature(key.sign(token.encode(), ec.ECDSA(hashes.SHA256())))
    token += "." + b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={token}, k={b64(public_key(key))}"
