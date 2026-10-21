"""The egress filter for networked sandbox runs (Hermes phase 7, 2026-09-24).

core/sandbox.py runs with no network. Some runs need the internet - fetching
a package, the read-only browser of step 3 - but on Docker Desktop an
ordinarily networked container reaches services on this computer's
loopback, Kairos's own API among them (scripts/test_sandbox.py proves it).
So a networked run gets no route of its own:

- It joins `jarvis-sbx-internal`, a Docker network created `--internal`:
  no route out and no outside DNS (checked on this machine).
- The only other thing on that network is this filter: a small proxy in its
  own hardened container, also on Docker's ordinary bridge. The run's
  HTTP_PROXY/HTTPS_PROXY point at it, and nothing else is reachable.
- The proxy resolves each destination itself and refuses any that is not a
  public address - loopback, private ranges, link-local (cloud metadata),
  carrier-grade NAT (Tailscale), Docker's own - and any port but 80 and 443.
  It then connects to the address it checked, so a name cannot resolve to
  something public for the check and something private for the connection.
  A redirect is a new request through the proxy and is checked again.
  Since 2026-10-16, person-approved computer previews may reach explicitly
  granted loopback ports through host.docker.internal, scoped by container IP.
  Only the backend's docker exec can reach the proxy's loopback control socket.

Hermes Agent routes its Docker backend through an egress proxy for the same
reason (tools/environments/docker_egress.py); this one is stdlib-only and
runs from source passed on the command line, so nothing extra is mounted.
"""
import asyncio
import json
import logging

logger = logging.getLogger(__name__)

NETWORK = "jarvis-sbx-internal"
PROXY_NAME = "jarvis-sbx-egress"
PROXY_PORT = 8888
CONTROL_PORT = 8889
PROXY_URL = f"http://{PROXY_NAME}:{PROXY_PORT}"
LABEL = "jarvis-sandbox-egress"  # not core/sandbox.py's LABEL: runs are counted apart from the filter

PROXY_SOURCE = r'''
import asyncio, ipaddress, socket, json
from urllib.parse import urlsplit

PORTS = {80, 443}
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
grants = {}
connections = {}


async def control(r, w):
    try:
        command = json.loads(await asyncio.wait_for(r.readline(), 5))
        ip = str(ipaddress.ip_address(command["ip"]))
        ports = set(command["ports"])
        if any(type(p) is not int or not 1 <= p <= 65535 for p in ports):
            raise ValueError("bad ports")
        grants[ip] = ports
        # 2026-10-16: revocation closes existing HTTP/CONNECT/upgrade pipes too.
        for port, writers in list(connections.get(ip, {}).values()):
            if port not in ports:
                for writer in writers:
                    writer.close()
        w.write(b"ok\n")
        await w.drain()
    except Exception:
        w.write(b"error\n")
    finally:
        w.close()


def public(ip):
    a = ipaddress.ip_address(ip.split("%")[0])
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.is_global and not a.is_multicast


async def refuse(w, why):
    print("BLOCKED", why, flush=True)
    try:
        w.write(b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Kairos-Egress-Error: 1\r\nConnection: close\r\n\r\n"
                b"Blocked by the Kairos sandbox egress filter: " + why.encode() + b"\n")
        await w.drain()
    finally:
        w.close()


async def pipe(r, w):
    try:
        while True:
            data = await r.read(65536)
            if not data:
                break
            w.write(data)
            await w.drain()
    except Exception:
        pass
    finally:
        try:
            w.close()
        except Exception:
            pass


async def handle(r, w):
    try:
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 30)
    except Exception:
        w.close()
        return
    line, _, rest = head.partition(b"\r\n")
    try:
        method, target, version = line.decode("latin-1").split(" ", 2)
    except ValueError:
        return await refuse(w, "malformed request")
    if method == "CONNECT":
        host, _, port = target.rpartition(":")
        forward = None
    else:
        u = urlsplit(target)
        if u.scheme != "http" or not u.hostname:
            return await refuse(w, "only absolute http:// requests or CONNECT")
        host, port = u.hostname, str(u.port or 80)
        path = (u.path or "/") + ("?" + u.query if u.query else "")
        keep = [h for h in rest[:-4].split(b"\r\n")
                if h and not h.lower().startswith((b"proxy-", b"connection:", b"keep-alive:"))]
        forward = (f"{method} {path} {version}\r\n".encode() + b"\r\n".join(keep + [b"Connection: close"]) + b"\r\n\r\n")
    host = host.strip("[]")
    try:
        port = int(port)
    except ValueError:
        return await refuse(w, "bad port")
    peer = w.get_extra_info("peername")[0]
    local = host.lower() in LOCAL_HOSTS
    if local and port not in grants.get(peer, set()):
        return await refuse(w, f"local app at {host}:{port} is not approved or was revoked")
    if not local and port not in PORTS:
        return await refuse(w, f"port {port} is not 80 or 443")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            "host.docker.internal" if local else host, port, type=socket.SOCK_STREAM)
    except OSError:
        return await refuse(w, f"cannot resolve {host}")
    ips = sorted({i[4][0] for i in infos})
    if not ips or (not local and not all(public(ip) for ip in ips)):
        return await refuse(w, f"{host} is a private or local address {ips}")
    try:
        ur, uw = await asyncio.wait_for(asyncio.open_connection(ips[0], port), 15)
    except Exception:
        if local:
            return await refuse(w, f"nothing is answering at http://{host}:{port} on this computer")
        return await refuse(w, f"cannot connect to {host}")
    token = object()
    if local:
        # A revoke may arrive while DNS or connect is pending (2026-10-16).
        if port not in grants.get(peer, set()):
            uw.close()
            return await refuse(w, "local app access was revoked")
        connections.setdefault(peer, {})[token] = (port, (w, uw))
        # The rewritten request already keeps the browser's Host header (the
        # app answers 400 without it) and closes after one response, so a
        # reused proxy connection cannot carry another origin's request to
        # the app; WebSockets arrive as CONNECT (2026-10-16).
    print("ALLOWED", method, host, port, ips[0], flush=True)
    if forward is None:
        w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await w.drain()
    else:
        uw.write(forward)
        await uw.drain()
    try:
        await asyncio.gather(pipe(r, uw), pipe(ur, w))
    finally:
        connections.get(peer, {}).pop(token, None)


async def main():
    control_server = await asyncio.start_server(control, "127.0.0.1", CONTROL_NUMBER)
    server = await asyncio.start_server(handle, "0.0.0.0", PORT_NUMBER)
    print("egress filter listening", flush=True)
    async with server, control_server:
        await server.serve_forever()

asyncio.run(main())
'''.replace("PORT_NUMBER", str(PROXY_PORT)).replace("CONTROL_NUMBER", str(CONTROL_PORT))


async def _docker(*args: str, timeout: float = 60) -> tuple[int, str, str]:
    from core.sandbox import _docker as docker
    return await docker(*args, timeout=timeout)


def run_args() -> list[str]:
    """What a networked run uses in place of `--network none`."""
    return ["--network", NETWORK,
            "-e", f"HTTP_PROXY={PROXY_URL}", "-e", f"HTTPS_PROXY={PROXY_URL}",
            "-e", f"http_proxy={PROXY_URL}", "-e", f"https_proxy={PROXY_URL}",
            "-e", "NO_PROXY=", "-e", "no_proxy="]


_lock = asyncio.Lock()
_grants: dict[str, set[int]] = {}


async def _apply(ip: str, ports: set[int]) -> None:
    command = json.dumps({"ip": ip, "ports": sorted(ports)}) + "\n"
    source = ("import socket; s=socket.create_connection(('127.0.0.1', "
              f"{CONTROL_PORT}),5); s.sendall({command.encode()!r}); "
              "assert s.recv(32) == b'ok\\n'; s.close()")
    try:
        code, _, err = await _docker("exec", PROXY_NAME, "python", "-c", source, timeout=10)
    except OSError as error:
        raise RuntimeError(f"could not update local app access: {error}") from error
    if code:
        raise RuntimeError("could not update local app access; the egress proxy may need a restart: "
                           + err.strip()[:200])


async def set_grants(ip: str, ports: set[int]) -> None:
    async with _lock:
        # 2026-10-16: failed clears remain tombstones until ensure can apply them.
        previous = _grants.get(ip, set())
        _grants[ip] = previous & ports
        await _apply(ip, ports)
        if ports:
            _grants[ip] = set(ports)
        else:
            _grants.pop(ip, None)


async def container_ip(name: str) -> str:
    import ipaddress
    code, out, _ = await _docker("inspect", name, "--format",
                               '{{(index .NetworkSettings.Networks "' + NETWORK + '").IPAddress}}')
    if code:
        raise RuntimeError("could not identify this computer's sandbox network address")
    return str(ipaddress.ip_address(out.strip()))


async def ensure(image: str) -> None:
    """Create the internal network and start the filter if they are not
    there. Raises RuntimeError when either cannot be set up; a networked run
    then does not happen."""
    async with _lock:
        code, out, _ = await _docker("network", "inspect", NETWORK, "--format", "{{.Internal}}")
        if code != 0:
            code, _, err = await _docker("network", "create", "--internal", "--label", LABEL, NETWORK)
            if code != 0:
                raise RuntimeError(f"could not create the sandbox network: {err.strip()[:200]}")
        elif out.strip() != "true":
            raise RuntimeError(f"a Docker network named {NETWORK} exists and is not internal")
        code, out, _ = await _docker("inspect", PROXY_NAME, "--format", "{{.State.Running}}")
        if code == 0 and out.strip() == "true":
            for ip, ports in list(_grants.items()):
                await _apply(ip, ports)
                if not ports:
                    _grants.pop(ip, None)
            return
        if code == 0:
            await _docker("rm", "-f", PROXY_NAME)
        code, _, err = await _docker(
            "run", "-d", "--rm", "--name", PROXY_NAME, "--label", LABEL, "--network", "bridge",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
            "--user", "65534:65534", "--pids-limit", "64", "--memory", "128m", "--memory-swap", "128m",
            image, "python", "-c", PROXY_SOURCE)
        if code != 0:
            raise RuntimeError(f"could not start the egress filter: {err.strip()[:200]}")
        code, _, err = await _docker("network", "connect", NETWORK, PROXY_NAME)
        if code != 0:
            await _docker("rm", "-f", PROXY_NAME)
            raise RuntimeError(f"could not attach the egress filter: {err.strip()[:200]}")
        for _ in range(50):  # a run started before it listens would just fail
            _, logs, _ = await _docker("logs", PROXY_NAME)
            if "listening" in logs:
                for ip, ports in _grants.items():
                    await _apply(ip, ports)
                logger.info("sandbox egress filter started")
                return
            await asyncio.sleep(0.2)
        await _docker("rm", "-f", PROXY_NAME)
        raise RuntimeError("the egress filter did not start listening")


async def stop() -> None:
    await _docker("rm", "-f", PROXY_NAME)
