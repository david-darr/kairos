"""Remote access over Tailscale — reach this JARVIS from your phone or
another computer, without exposing anything to the open internet.

David's ask (2026-09-03): users setting up the downloaded app should be able
to turn this on themselves, the way scripts/run_remote.py does it by hand
here. That script stays as the dev/CLI path; this module is the in-app
equivalent, driven from Settings > Remote Access and offered during
onboarding.

Security model, unchanged from the script and deliberately strict:
  - Bind to the machine's own Tailscale interface IP, never 0.0.0.0. The
    listener is reachable only from devices on your tailnet.
  - Serve real HTTPS using a Tailscale-issued certificate for the machine's
    MagicDNS name. Browsers need a genuine secure context, and a self-signed
    cert would train users to click through warnings.
  - Require real accounts. enable() refuses to start unless auth is on and
    an account exists, so the single-trusted-local-user bypass can never be
    what answers a request arriving over the network.

Runs as a second uvicorn server inside this same process (an asyncio task
serving the same FastAPI app) rather than a subprocess. The script needed a
subprocess because it wanted --reload; nothing here does, and an in-process
server means start/stop from the UI is immediate, has no orphan-process
risk, and shares the already-warm application state.

Certificates are written to DATA_DIR/certs, never into the app directory:
they're per-machine secrets that must not end up in a backup, a git commit,
or a packaged build. (The original script wrote them into scripts/, which is
exactly how they nearly shipped inside an installer — see the 2026-09-03
packaging audit.)

A watchdog runs beside the listener (found 2026-11-01: one user's remote
access kept dying while Settings said Live, and only a restart brought it
back). The listener binds once to the Tailscale address; when Tailscale's
adapter drops (sleep/wake, a network change, a Tailscale restart or update)
the server task stays alive but nothing reaches it, and "Live" only ever
meant "the task hasn't exited". The watchdog re-reads Tailscale and makes a
real HTTPS request to the listener every WATCHDOG_INTERVAL seconds, rebuilds
it when that fails, and is what Settings now reports. It also renews the
certificate, which used to be reused forever although Tailscale's last about
90 days.
"""
import asyncio
import json
import logging
import os
import shutil
import ssl
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Optional

from core import events, settings as settings_store
from core.auth import auth_enabled, auth_manager
from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

CERTS_DIR = os.path.join(DATA_DIR, "certs")

_WINDOWS_DEFAULT = r"C:\Program Files\Tailscale\tailscale.exe"
_MACOS_DEFAULT = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

WATCHDOG_INTERVAL = 30          # seconds between checks
FAILURES_BEFORE_RESTART = 2     # one slow answer isn't a dead listener
PROBE_TIMEOUT = 5
CERT_RENEW_DAYS = 30            # renew this long before expiry
CERT_RETRY_SECONDS = 6 * 3600   # a failed renewal waits this long; Tailscale rate-limits issuance

_server = None          # uvicorn.Server
_server_task: asyncio.Task | None = None
_current_url: Optional[str] = None
_bound: Optional[tuple[str, str, int]] = None   # (ip, hostname, port) the listener is on
_watchdog_task: asyncio.Task | None = None
_failures = 0
_last_renew_attempt = 0.0
_last_renew_error: Optional[str] = None


def _fresh_health(state: str) -> dict:
    return {"state": state, "reachable": None, "last_check": None, "last_ok": None,
            "last_error": None, "last_error_at": None, "restarts": 0}


# state: off | checking (started, not probed yet) | live | reconnecting
# (listener up but not answering) | waiting (Tailscale down, or a restart failed)
_health = _fresh_health("off")


def health() -> dict:
    return dict(_health)


# -- Tailscale discovery ---------------------------------------------------

def tailscale_exe() -> Optional[str]:
    found = shutil.which("tailscale")
    if found:
        return found
    for candidate in (_WINDOWS_DEFAULT, _MACOS_DEFAULT, "/usr/bin/tailscale"):
        if os.path.exists(candidate):
            return candidate
    return None


def _run_tailscale(args: list[str], timeout: int = 15) -> Optional[subprocess.CompletedProcess]:
    exe = tailscale_exe()
    if not exe:
        return None
    try:
        return subprocess.run(
            [exe, *args], capture_output=True, text=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.warning("remote_access: tailscale %s failed: %s", " ".join(args), e)
        return None


def _status_json() -> Optional[dict]:
    result = _run_tailscale(["status", "--json"])
    if result is None or result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except ValueError:
        return None


def _tailnet() -> dict:
    """Tailscale's view of this machine. Cheap enough for the watchdog to
    call every check, unlike detect(), which also asks Windows Firewall."""
    info = {"installed": tailscale_exe() is not None, "running": False,
            "logged_in": False, "ip": None, "hostname": None}
    if not info["installed"]:
        return info
    status = _status_json()
    if status is None:
        return info
    info["running"] = True
    info["logged_in"] = status.get("BackendState", "") == "Running"
    self_node = status.get("Self") or {}
    ips = self_node.get("TailscaleIPs") or []
    info["ip"] = next((ip for ip in ips if ":" not in ip), None)
    info["hostname"] = (self_node.get("DNSName") or "").rstrip(".") or None
    return info


def detect() -> dict:
    """Everything the setup UI needs to tell the user exactly which step
    they're stuck on, rather than one opaque "couldn't start" failure.
    Every field is safe to show: no keys, no auth tokens."""
    info = {
        "has_cert": False,
        "cert_days_left": None,
        "auth_ready": auth_enabled() and auth_manager.has_any_users(),
        # Distinct from auth_ready: lets the UI tell "no account yet" apart
        # from "an account exists but login enforcement is off" — the two
        # need different fixes (create one vs. just flip the setting) and
        # collapsing them into one flag was the dead end found live
        # 2026-09-10 (see routes/remote_routes.py::create_account).
        "has_any_users": auth_manager.has_any_users(),
        "enabled": bool(settings_store.get_setting("remote_access_enabled")),
        "running_now": is_running(),
        "url": _current_url,
        "port": settings_store.get_setting("remote_access_port") or 8422,
        # Without this rule the listener starts fine and stays unreachable
        # from every other device — the failure mode that looks like
        # "everything is configured and nothing connects".
        "firewall_ok": firewall_rule_exists(),
        # What the watchdog last saw. "Live" in Settings means this says the
        # listener answered, not just that its task is still running.
        "health": health(),
    }
    info.update(_tailnet())
    hostname = info["hostname"]
    if hostname:
        cert_path, key_path = _cert_paths(hostname)
        info["has_cert"] = os.path.exists(cert_path) and os.path.exists(key_path)
        if info["has_cert"]:
            days = _cert_days_left(cert_path)
            info["cert_days_left"] = None if days is None else int(days)
    return info


# -- certificates ----------------------------------------------------------

def _cert_paths(hostname: str) -> tuple[str, str]:
    return (
        os.path.join(CERTS_DIR, f"{hostname}.crt"),
        os.path.join(CERTS_DIR, f"{hostname}.key"),
    )


def _cert_days_left(cert_path: str) -> Optional[float]:
    """Days until the certificate expires, or None if it can't be read."""
    try:
        from cryptography import x509
        with open(cert_path, "rb") as f:
            cert = x509.load_pem_x509_certificate(f.read())
    except (OSError, ValueError):
        return None
    return (cert.not_valid_after_utc - datetime.now(timezone.utc)).total_seconds() / 86400


def _fetch_cert(hostname: str, cert_path: str, key_path: str) -> Optional[str]:
    """Ask Tailscale for a certificate at these paths. Returns an error, or None."""
    result = _run_tailscale(
        ["cert", "--cert-file", cert_path, "--key-file", key_path, hostname],
        timeout=90,
    )
    if result is None:
        return "Couldn't run the Tailscale command."
    if result.returncode != 0 or not (os.path.exists(cert_path) and os.path.exists(key_path)):
        detail = (result.stderr or result.stdout or "").strip()
        if "HTTPS" in detail or "https" in detail:
            return (
                "HTTPS certificates aren't enabled for your tailnet. Turn them on at "
                "login.tailscale.com/admin/dns (under HTTPS Certificates), then try again."
            )
        return detail or "Tailscale couldn't issue a certificate."
    return None


def _renew_cert(hostname: str) -> Optional[str]:
    """Fetch a new pair beside the current one and swap it in only once both
    files arrived, so a failed renewal never breaks a working certificate."""
    global _last_renew_attempt, _last_renew_error
    _last_renew_attempt = time.time()
    cert_path, key_path = _cert_paths(hostname)
    new_cert, new_key = cert_path + ".new", key_path + ".new"
    error = _last_renew_error = _fetch_cert(hostname, new_cert, new_key)
    if error:
        for leftover in (new_cert, new_key):
            try:
                os.remove(leftover)
            except OSError:
                pass
        return error
    os.replace(new_key, key_path)
    os.replace(new_cert, cert_path)
    logger.info("remote_access: renewed the HTTPS certificate for %s", hostname)
    return None


def provision_cert(hostname: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Returns (cert_path, key_path, error). Reuses an existing pair rather
    than re-requesting: Tailscale rate-limits cert issuance. A pair inside
    CERT_RENEW_DAYS of expiry is renewed; if that fails while it's still
    valid, it's kept and the watchdog tries again later."""
    os.makedirs(CERTS_DIR, exist_ok=True)
    cert_path, key_path = _cert_paths(hostname)
    if os.path.exists(cert_path) and os.path.exists(key_path):
        days = _cert_days_left(cert_path)
        # An unreadable pair is reused as before rather than re-requested on
        # every start, which is exactly what the rate limit punishes.
        if days is None or days > CERT_RENEW_DAYS:
            return cert_path, key_path, None
        # Every path backs off after a failed renewal: with an expired
        # certificate the watchdog rebuilds every 30 seconds, and each
        # rebuild would otherwise ask Tailscale again.
        if time.time() - _last_renew_attempt < CERT_RETRY_SECONDS:
            error = _last_renew_error or "a renewal was tried recently"
        else:
            error = _renew_cert(hostname)
        if error is None:
            return cert_path, key_path, None
        if days > 0:
            logger.warning("remote_access: certificate renewal failed (%s); keeping the current one, %d days left",
                           error, int(days))
            return cert_path, key_path, None
        return None, None, f"This machine's HTTPS certificate expired and Tailscale couldn't renew it: {error}"

    error = _fetch_cert(hostname, cert_path, key_path)
    if error:
        return None, None, error
    return cert_path, key_path, None


# -- the listener ----------------------------------------------------------

# -- Windows Firewall ------------------------------------------------------
# Found live 2026-09-03, and it's the thing that actually blocks a working
# setup: binding a socket needs no permission, so the listener starts happily
# and localhost reaches it — but Windows Firewall drops *inbound* connections
# from other devices unless the listening executable has an allow rule.
#
# David's old scripts/run_remote.py worked because it ran under a Python that
# already had a rule. The packaged app runs its own bundled interpreter at a
# brand-new path, which has none, and no prompt ever appears because a
# background console process binding a socket doesn't trigger one. Net effect:
# everything looks correct and nothing connects.
# No spaces, deliberately. Start-Process -ArgumentList joins its array on
# spaces, so a name like "JARVIS Remote Access" reached netsh as three
# separate tokens — it created a rule called just "JARVIS" and silently
# dropped the rest (found live 2026-09-03, after the log claimed success and
# the rule turned out to be named something else).
FIREWALL_RULE_NAME = "JARVIS-Remote-Access"


def _current_python() -> str:
    return os.path.abspath(sys.executable)


def firewall_rule_exists() -> bool:
    """True if an inbound allow rule already covers this interpreter. Only
    meaningful on Windows; other platforms return True so the UI doesn't show
    a step that doesn't apply."""
    if os.name != "nt":
        return True
    exe = _current_python()
    ps = (
        "$ErrorActionPreference='SilentlyContinue';"
        "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -ieq '"
        + exe.replace("'", "''")
        + "' } | ForEach-Object { $r = $_ | Get-NetFirewallRule; "
        "if ($r.Direction -eq 'Inbound' -and $r.Action -eq 'Allow' -and $r.Enabled -eq 'True') { 'FOUND' } }"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return "FOUND" in (result.stdout or "")
    except (OSError, subprocess.TimeoutExpired):
        # Can't tell — don't block the user or nag them about a step we
        # failed to check.
        return True


def add_firewall_rule() -> tuple[bool, str]:
    """Add the inbound allow rule for this interpreter, via an elevated
    prompt. Returns (ok, message).

    Deliberately user-initiated and UAC-gated: this opens a port on the
    machine to the tailnet, which is exactly the kind of change that should
    require an explicit, visible consent step rather than happening quietly.
    """
    if os.name != "nt":
        return False, "Firewall setup is only automated on Windows."
    exe = _current_python()
    # Start-Process -Verb RunAs is what raises the UAC prompt; without it the
    # netsh call fails silently for a non-elevated user. Each argument is a
    # separate, individually-quoted array element — the program path contains
    # spaces, and anything unquoted here gets word-split before netsh sees it.
    def q(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    args = ",".join([
        q("advfirewall"), q("firewall"), q("add"), q("rule"),
        q(f"name={FIREWALL_RULE_NAME}"),
        q("dir=in"), q("action=allow"),
        q(f'program="{exe}"'),
        q("enable=yes"), q("profile=any"),
    ])
    ps = f"Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList {args}"
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=120,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"Couldn't run the firewall command: {e}"

    if result.returncode != 0:
        detail = (result.stderr or "").strip()
        if "canceled" in detail.lower() or "cancelled" in detail.lower():
            return False, "The permission prompt was declined, so the rule wasn't added."
        return False, detail or "Windows refused to add the firewall rule."

    if firewall_rule_exists():
        logger.info("remote_access: firewall rule added for %s", exe)
        return True, "Firewall rule added."
    return False, "The rule didn't appear — you may have declined the permission prompt."
    # (Deliberately re-checks rather than trusting the exit code: the elevated
    #  process is a separate one, and a declined UAC still exits cleanly here.)


def _port_available(host: str, port: int) -> tuple[bool, str]:
    """Can we actually bind here? Returns (ok, error_text)."""
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # No SO_REUSEADDR: we want this to fail exactly when a real listener
        # already holds the address, which is the condition we're testing.
        sock.bind((host, port))
        return True, ""
    except OSError as e:
        return False, str(e)
    finally:
        sock.close()


def is_running() -> bool:
    return _server_task is not None and not _server_task.done()


def is_watching() -> bool:
    return _watchdog_task is not None and not _watchdog_task.done()


async def start() -> dict:
    """Bring up the HTTPS listener and its watchdog. Returns {"ok": bool,
    "url"/"error": ...}. Safe to call when already running (no-op)."""
    global _health

    if is_running():
        return {"ok": True, "url": _current_url}

    # One actor at a time: a watchdog left waiting from startup must not
    # rebuild the listener while this call is doing the same.
    await _cancel_watchdog()
    result = await _start_listener()
    if not result["ok"]:
        return result
    _health = _fresh_health("checking")
    _ensure_watchdog()
    events.emit("remote.enabled", f"Remote access on at {_current_url}")
    logger.info("remote_access: listening on %s (%s:%s)", _current_url, _bound[0], _bound[2])
    return result


async def _start_listener() -> dict:
    """The gates, the certificate and the bind. No events and no watchdog,
    so the watchdog can call it to rebuild a listener that stopped answering."""
    global _server, _server_task, _current_url, _bound

    # In a thread: the Tailscale command and a certificate fetch block for
    # seconds, and this runs on the loop that also serves the app.
    info = await asyncio.to_thread(_tailnet)
    if not info["installed"]:
        return {"ok": False, "error": "Tailscale isn't installed on this machine."}
    if not info["logged_in"]:
        return {"ok": False, "error": "Tailscale is installed but not signed in. Open Tailscale and log in, then try again."}
    if not info["ip"] or not info["hostname"]:
        return {"ok": False, "error": "Couldn't determine this machine's Tailscale address."}
    # The hard gate: never expose the app to a network while it would answer
    # with the no-login local-user bypass.
    if not (auth_enabled() and auth_manager.has_any_users()):
        return {"ok": False, "error": "Create an account first — remote access can't be turned on without a login."}

    cert_path, key_path, err = await asyncio.to_thread(provision_cert, info["hostname"])
    if err:
        return {"ok": False, "error": err}

    port = int(settings_store.get_setting("remote_access_port") or 8422)

    # Check the port ourselves before handing it to uvicorn. This is not
    # belt-and-braces: on a bind failure uvicorn calls sys.exit(), which
    # raises SystemExit — a BaseException, so it escapes the task and
    # unwinds the event loop rather than being caught as a normal error.
    # Enabling remote access on an occupied port would take the whole
    # backend down with it. Testing the bind here keeps that path from
    # ever being reached (found while testing against a port the dev
    # script was holding, 2026-09-03).
    available, bind_error = _port_available(info["ip"], port)
    if not available:
        return {"ok": False, "error": (
            f"Port {port} is already in use on this machine — something else is bound to it "
            f"(another Kairos listener, or scripts/run_remote.py). Pick a different port below, "
            f"or stop whatever is using it. ({bind_error})"
        )}

    # Imported here, not at module scope: uvicorn is only needed when remote
    # access is actually switched on.
    import uvicorn
    from app import app as fastapi_app

    config = uvicorn.Config(
        fastapi_app,
        host=info["ip"],
        port=port,
        ssl_certfile=cert_path,
        ssl_keyfile=key_path,
        log_level="info",
        # This server shares the running event loop; uvicorn must not try to
        # install its own signal handlers on a loop it doesn't own.
        lifespan="off",
    )
    _server = uvicorn.Server(config)
    _server.install_signal_handlers = lambda: None

    _server_task = asyncio.create_task(_server.serve())
    # Give it a moment to bind so a port conflict surfaces here, as a real
    # error in the UI, rather than silently in a background task.
    try:
        await asyncio.sleep(1.0)
    except asyncio.CancelledError:
        # The watchdog was cancelled mid-rebuild (by start() or stop()):
        # shut the half-started server down properly so it doesn't keep
        # holding the port the caller is about to bind.
        await _stop_listener()
        raise
    if _server_task.done():
        # .exception() re-raises CancelledError and can itself surface a
        # BaseException (uvicorn exits via sys.exit on startup failure), so
        # it's read defensively — the pre-bind check above should mean we
        # never get here for the common port-conflict case.
        try:
            exc = _server_task.exception()
        except BaseException as e:  # noqa: BLE001 - deliberately broad
            exc = e
        _server_task = None
        _server = None
        return {"ok": False, "error": f"Couldn't start the listener on port {port}: {exc or 'startup failed'}"}

    _current_url = f"https://{info['hostname']}:{port}"
    _bound = (info["ip"], info["hostname"], port)
    return {"ok": True, "url": _current_url}


async def stop() -> None:
    global _health
    await _cancel_watchdog()
    was_on = _current_url
    await _stop_listener()
    if was_on:
        events.emit("remote.disabled", "Remote access turned off")
    _health = _fresh_health("off")


async def _stop_listener() -> None:
    global _server, _server_task, _current_url, _bound
    if _server is not None:
        _server.should_exit = True
    if _server_task is not None:
        try:
            await asyncio.wait_for(_server_task, timeout=10)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            _server_task.cancel()
        except Exception:
            logger.exception("remote_access: error stopping the listener")
    _server = None
    _server_task = None
    _current_url = None
    _bound = None


async def start_if_enabled() -> None:
    """Called once at app startup so the setting survives a restart — the
    whole point of a persisted toggle. Never raises: a machine that has since
    dropped off the tailnet should still boot the app normally, and the
    watchdog keeps trying, so remote access comes up once Tailscale does
    (the Visualizer's listener had exactly this bug: one try at boot, none
    after)."""
    if not settings_store.get_setting("remote_access_enabled"):
        return
    try:
        result = await start()
        if not result["ok"]:
            logger.warning("remote_access: enabled but couldn't start — %s", result["error"])
            events.emit("remote.failed", f"Remote access couldn't start: {result['error']}", level="warn")
            _record_failure(result["error"], "waiting")
            _ensure_watchdog()
    except Exception:
        logger.exception("remote_access: unexpected error during startup")


# -- the watchdog ----------------------------------------------------------

def _ensure_watchdog() -> None:
    global _watchdog_task
    if not is_watching():
        _watchdog_task = asyncio.create_task(_watch())


async def _cancel_watchdog() -> None:
    global _watchdog_task
    task, _watchdog_task = _watchdog_task, None
    if task is None or task.done() or task is asyncio.current_task():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        # The watchdog's own cancellation is expected; a cancellation of
        # whoever is calling this (app shutdown) must still propagate.
        if asyncio.current_task().cancelling():
            raise
    except Exception:
        pass


async def _watch() -> None:
    while True:
        try:
            await check_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("remote_access: watchdog check failed")
        await asyncio.sleep(WATCHDOG_INTERVAL)


async def check_once() -> None:
    """One watchdog pass. Public so tests drive it without waiting."""
    global _failures
    tail = await asyncio.to_thread(_tailnet)
    if not (tail["logged_in"] and tail["ip"] and tail["hostname"]):
        if is_running() and await _probe(*_bound) is None:
            # Tailscale's command didn't answer (it times out under load),
            # but the listener did: not a reason to take it down.
            _failures = 0
            _mark_live()
            return
        # A listener bound to an address that's gone can't be reached, and
        # leaving it up is what made Settings say Live.
        if is_running():
            await _stop_listener()
        _record_failure("Tailscale is off or signed out on this machine. Remote access comes back when it is.", "waiting")
        return
    if not is_running():
        await _rebuild("the listener wasn't running")
        return
    if (tail["ip"], tail["hostname"]) != _bound[:2]:
        await _restart(f"this machine's Tailscale address changed to {tail['ip']}")
        return
    if await _maybe_renew_cert(tail["hostname"]):
        await _restart("the HTTPS certificate was renewed", quiet=True)
        return
    error = await _probe(*_bound)
    if error is None:
        _failures = 0
        _mark_live()
        return
    _failures += 1
    _record_failure(error, "reconnecting")
    if _failures >= FAILURES_BEFORE_RESTART:
        await _restart(error)


async def _probe(ip: str, hostname: str, port: int) -> Optional[str]:
    """A real HTTPS request to the listener, on the address a phone uses.
    Returns what went wrong, or None. The certificate isn't verified here:
    the question is whether the listener answers; expiry is checked apart.
    Run from this machine, so it catches a dead listener or a lost address,
    not a firewall or a phone that dropped off the tailnet."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port, ssl=context, server_hostname=hostname), PROBE_TIMEOUT)
        writer.write(f"GET /api/auth/status HTTP/1.1\r\nHost: {hostname}:{port}\r\nConnection: close\r\n\r\n".encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), PROBE_TIMEOUT)
    except asyncio.TimeoutError:
        return f"The listener on port {port} didn't answer within {PROBE_TIMEOUT} seconds."
    except (OSError, ssl.SSLError) as e:
        return f"Couldn't reach the listener on port {port}: {e}"
    finally:
        if writer is not None:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 2)
            except Exception:
                pass
    if not line.startswith(b"HTTP/1.1 200"):
        return f"The listener on port {port} answered oddly: {line[:60].decode(errors='replace').strip() or 'nothing'}"
    return None


async def _maybe_renew_cert(hostname: str) -> bool:
    cert_path, _ = _cert_paths(hostname)
    days = _cert_days_left(cert_path)
    if days is None or days > CERT_RENEW_DAYS or time.time() - _last_renew_attempt < CERT_RETRY_SECONDS:
        return False
    error = await asyncio.to_thread(_renew_cert, hostname)
    if error:
        logger.warning("remote_access: certificate renewal failed (%s), %d days left; trying again later", error, int(days))
        return False
    return True


async def _restart(reason: str, quiet: bool = False) -> None:
    if not quiet:
        _record_failure(reason, "reconnecting")
        logger.warning("remote_access: restarting the listener: %s", reason)
    await _stop_listener()
    await _rebuild(reason)


async def _rebuild(reason: str) -> None:
    global _failures
    result = await _start_listener()
    if not result["ok"]:
        _record_failure(result["error"], "waiting")
        return
    _failures = 0
    _health["restarts"] += 1
    logger.info("remote_access: listener rebuilt (%s)", reason)
    error = await _probe(*_bound)
    if error is None:
        _mark_live()
    else:
        _record_failure(error, "reconnecting")


def _record_failure(error: str, state: str) -> None:
    now = time.time()
    was_live = _health["state"] in ("live", "checking")
    if error != _health["last_error"] or state != _health["state"]:
        # Logged on change only: a machine off the tailnet for a day would
        # otherwise write the same line every 30 seconds.
        logger.warning("remote_access: %s", error)
        _health["last_error_at"] = now
    _health.update(state=state, reachable=False, last_check=now, last_error=error)
    if was_live:
        events.emit("remote.dropped", f"Remote access stopped answering: {error}", level="warn")


def _mark_live() -> None:
    now = time.time()
    was_down = _health["state"] in ("reconnecting", "waiting")
    _health.update(state="live", reachable=True, last_check=now, last_ok=now)
    if was_down:
        logger.info("remote_access: answering again at %s", _current_url)
        events.emit("remote.recovered", f"Remote access is answering again at {_current_url}")
