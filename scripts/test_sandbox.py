"""Adversarial tests for core/sandbox.py (Hermes phase 7 step 1).

Each test tries to get out of the container the way a steered model would:
read the host's files, reach the network or JARVIS's own API, find secrets,
gain privileges, or exhaust the machine. They need Docker running; without
it they are skipped, loudly, and the sandbox itself refuses to run.

    python scripts/test_sandbox.py
"""
import asyncio
import http.server
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch, AsyncMock

os.environ["JARVIS_DATA_DIR"] = tempfile.mkdtemp(prefix="jarvis-sbx-test-data-")  # never the real data
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from core import sandbox, tool_registry  # noqa: E402

DOCKER_UP = asyncio.run(sandbox.available())[0]


class LocalPreviewProxyTests(unittest.IsolatedAsyncioTestCase):
    """2026-10-16: exercise the shipped proxy source without Docker or sockets."""
    async def asyncSetUp(self):
        from core import sandbox_egress
        self.egress = sandbox_egress
        self.ns = {}
        exec(sandbox_egress.PROXY_SOURCE.rsplit("asyncio.run(main())", 1)[0], self.ns)
        self.ns["grants"]["172.22.0.7"] = {8082}

    class Writer:
        def __init__(self, ip="172.22.0.7"):
            self.ip, self.data, self.closed = ip, b"", False
        def get_extra_info(self, name): return (self.ip, 12345)
        def write(self, data): self.data += data
        async def drain(self): pass
        def close(self): self.closed = True

    def reader(self, data):
        reader = asyncio.StreamReader()
        reader.feed_data(data)
        reader.feed_eof()
        return reader

    async def request(self, target, ip="172.22.0.7", connect=False, response=b"HTTP/1.1 200 OK\r\n\r\npreview"):
        raw = (f"{'CONNECT' if connect else 'GET'} {target} HTTP/1.1\r\n"
               "Host: 127.0.0.1:8082\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").encode()
        downstream, upstream = self.Writer(ip), self.Writer()
        infos = [(None, None, None, None, ("192.168.65.254", 8082))]
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=infos)) as resolve, \
             patch.object(asyncio, "open_connection", AsyncMock(return_value=(self.reader(response), upstream))) as opened:
            await self.ns["handle"](self.reader(raw), downstream)
        return downstream, upstream, raw, resolve, opened

    async def test_approved_loopback_keeps_host_and_closes_after_one_response(self):
        # The app answers 400 without the browser's Host. Keep-alive is not
        # kept: a reused proxy connection could carry another origin's
        # request into the app unchecked (2026-10-16).
        for host in ("127.0.0.1", "localhost", "[::1]"):
            down, up, raw, resolve, opened = await self.request(f"http://{host}:8082/path")
            self.assertIn(b"200 OK", down.data)
            self.assertTrue(up.data.startswith(b"GET /path HTTP/1.1\r\n"), up.data)
            self.assertIn(b"\r\nHost: 127.0.0.1:8082\r\n", up.data)
            self.assertIn(b"\r\nConnection: close\r\n", up.data)
            self.assertEqual(resolve.call_args.args[:2], ("host.docker.internal", 8082))
            opened.assert_awaited_once_with("192.168.65.254", 8082)

    async def test_an_approved_websocket_tunnel_passes_its_bytes_through(self):
        down, up, _, _, opened = await self.request("127.0.0.1:8082", connect=True, response=b"ws-frames")
        self.assertIn(b"200 Connection established", down.data)
        self.assertIn(b"ws-frames", down.data)
        opened.assert_awaited_once_with("192.168.65.254", 8082)

    async def test_ungranted_ports_private_hosts_and_other_peers_refused(self):
        for target, ip in (("http://localhost:8083/", "172.22.0.7"),
                           ("http://localhost:8082/", "172.22.0.8"),
                           ("http://192.168.65.254:8082/", "172.22.0.7"),
                           ("http://private.example:80/", "172.22.0.7"),
                           ("http://host.docker.internal:80/", "172.22.0.7")):
            down, _, _, _, opened = await self.request(target, ip)
            self.assertIn(b"403 Forbidden", down.data)
            opened.assert_not_awaited()

    async def test_redirect_is_checked_as_new_request(self):
        down, _, _, _, _ = await self.request("http://localhost:8082/",
            response=b"HTTP/1.1 302 Found\r\nLocation: http://localhost:8083/\r\n\r\n")
        self.assertIn(b"Location: http://localhost:8083/", down.data)
        down, _, _, _, opened = await self.request("http://localhost:8083/")
        self.assertIn(b"403 Forbidden", down.data)
        opened.assert_not_awaited()

    async def test_connect_and_revoke_close_active_pipes(self):
        down, up, _, _, _ = await self.request("localhost:8082", connect=True)
        self.assertIn(b"200 Connection established", down.data)
        live_down, live_up = self.Writer(), self.Writer()
        self.ns["connections"]["172.22.0.7"] = {"live": (8082, (live_down, live_up))}
        control = self.Writer()
        await self.ns["control"](self.reader(b'{"ip":"172.22.0.7","ports":[]}\n'), control)
        self.assertEqual(control.data, b"ok\n")
        self.assertTrue(live_down.closed and live_up.closed)
        down, _, _, _, opened = await self.request("localhost:8082", connect=True)
        self.assertIn(b"revoked", down.data)
        opened.assert_not_awaited()

    async def test_app_not_running_explained(self):
        infos = [(None, None, None, None, ("192.168.65.254", 8082))]
        writer = self.Writer()
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=infos)), \
             patch.object(asyncio, "open_connection", AsyncMock(side_effect=OSError("refused"))):
            await self.ns["handle"](self.reader(b"GET http://127.0.0.1:8082/ HTTP/1.1\r\nHost: 127.0.0.1:8082\r\n\r\n"), writer)
        self.assertIn(b"nothing is answering at http://127.0.0.1:8082 on this computer", writer.data)

    async def test_proxy_restart_reapplies_grants(self):
        async def docker(*args, **kwargs):
            if args[:2] == ("network", "inspect"): return 0, "true", ""
            if args[0] == "inspect": return 1, "", "missing"
            if args[0] == "logs": return 0, "egress filter listening", ""
            return 0, "", ""
        with patch.object(self.egress, "_docker", AsyncMock(side_effect=docker)), \
             patch.object(self.egress, "_grants", {"172.22.0.7": {8082}}), \
             patch.object(self.egress, "_apply", AsyncMock()) as apply:
            await self.egress.ensure("fake-image")
            apply.assert_awaited_once_with("172.22.0.7", {8082})

    async def test_control_is_loopback_only_and_uses_exec(self):
        self.assertIn('start_server(control, "127.0.0.1",', self.egress.PROXY_SOURCE)
        with patch.object(self.egress, "_docker", AsyncMock(return_value=(0, "", ""))) as docker:
            await self.egress._apply("172.22.0.7", {8082})
            self.assertEqual(docker.call_args.args[:4], ("exec", self.egress.PROXY_NAME, "python", "-c"))
            from types import SimpleNamespace
            from unittest.mock import Mock
            connection = SimpleNamespace(sendall=Mock(), recv=Mock(return_value=b"ok\n"), close=Mock())
            with patch.object(socket, "create_connection", return_value=connection):
                exec(docker.call_args.args[4], {})
            self.assertEqual(connection.sendall.call_args.args[0], b'{"ip": "172.22.0.7", "ports": [8082]}\n')

    async def test_failed_clear_is_retried_before_another_run(self):
        async def docker(*args, **kwargs):
            return (0, "true", "")
        with patch.object(self.egress, "_grants", {"172.22.0.7": {8082}}), \
             patch.object(self.egress, "_apply", AsyncMock(side_effect=RuntimeError("offline"))):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                await self.egress.set_grants("172.22.0.7", set())
            self.assertEqual(self.egress._grants, {"172.22.0.7": set()})
            with patch.object(self.egress, "_docker", AsyncMock(side_effect=docker)), \
                 patch.object(self.egress, "_apply", AsyncMock()) as apply:
                await self.egress.ensure("fake-image")
                apply.assert_awaited_once_with("172.22.0.7", set())
            self.assertEqual(self.egress._grants, {})


def run(command, **kw):
    return asyncio.run(sandbox.run(command, **kw))


@unittest.skipUnless(DOCKER_UP, "Docker is not running - the sandbox is unproven on this run")
class EscapeTests(unittest.TestCase):

    def test_runs_unprivileged_on_a_read_only_system(self):
        # CapBnd is the ceiling a process could ever regain; only --cap-drop
        # empties it (CapEff is 0 for nobody anyway). /var/tmp is writable by
        # anyone, so only --read-only stops the write there.
        r = run("id -u; grep -E 'CapEff|CapBnd|NoNewPrivs' /proc/self/status; "
                "touch /etc/owned 2>/dev/null && echo ETC-WRITABLE; touch /var/tmp/owned 2>/dev/null && echo VARTMP-WRITABLE; "
                "touch /work/ok && echo WORK-OK")
        self.assertEqual(r.exit_code, 0, r.stderr)
        self.assertTrue(r.stdout.startswith("65534"), r.stdout)
        self.assertIn("CapEff:\t0000000000000000", r.stdout)
        self.assertIn("CapBnd:\t0000000000000000", r.stdout)
        self.assertIn("NoNewPrivs:\t1", r.stdout)
        self.assertNotIn("WRITABLE", r.stdout)
        self.assertIn("WORK-OK", r.stdout)

    def test_the_hosts_files_are_nowhere_in_the_container(self):
        token = f"canary-{uuid.uuid4().hex}"
        outside = Path(tempfile.mkdtemp(prefix="jarvis-canary-"))
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "secret.txt").write_text(token)
        r = run(f"grep -rl --exclude-dir=proc --exclude-dir=sys {token} / 2>/dev/null; "
                "echo ---; cat /proc/mounts; echo ---; ls /run/desktop /mnt/host /host_mnt /mnt/c 2>&1",
                timeout=240)
        found, mounts, listing = r.stdout.split("---\n")
        self.assertEqual(found.strip(), "", "a file outside the workspace was readable")
        host_mounts = [line for line in mounts.splitlines()
                       if line.split()[1] not in ("/", "/work", "/tmp") and not line.split()[1].startswith(("/proc", "/sys", "/dev"))]
        self.assertEqual([m for m in host_mounts if m.split()[1] not in ("/etc/resolv.conf", "/etc/hostname", "/etc/hosts",
                                                                    # --init's tini, read-only from Docker's own VM, not the host
                                                                    "/usr/sbin/docker-init")], [],
                         "only /work comes from the host")
        self.assertEqual(listing.count("No such file or directory"), 4, listing)

    def test_no_network_not_even_to_jarvis_on_this_machine(self):
        server, port = _host_http_server()
        self.addCleanup(server.server_close)  # runs after shutdown (cleanups run last-in, first-out)
        self.addCleanup(server.shutdown)
        probe = ("import socket\n"
                 "for host in ('host.docker.internal', '192.168.65.254', '10.0.2.2', '1.1.1.1', '172.17.0.1'):\n"
                 "    try:\n"
                 f"        socket.create_connection((host, {port} if not host[0].isdigit() or host.startswith('192') or host.startswith('172') or host.startswith('10') else 53), timeout=3)\n"
                 "        print('REACHED', host)\n"
                 "    except OSError as e:\n"
                 "        print('blocked', host, type(e).__name__)\n"
                 "import os; print('interfaces', sorted(os.listdir('/sys/class/net')))\n")
        r = run("python probe.py", files={"probe.py": probe}, timeout=60)
        self.assertEqual(r.exit_code, 0, r.stderr)
        self.assertNotIn("REACHED", r.stdout)
        self.assertIn("interfaces ['lo']", r.stdout)

    def test_control_a_networked_container_would_reach_jarvis(self):
        """Without --network none the same probe gets through. This is why a
        networked run goes through core/sandbox_egress.py's filter instead, and
        why the test above means something."""
        server, port = _host_http_server()
        self.addCleanup(server.server_close)  # runs after shutdown (cleanups run last-in, first-out)
        self.addCleanup(server.shutdown)
        out = subprocess.run(["docker", "run", "--rm", sandbox.IMAGE, "python", "-c",
                              f"import urllib.request;print(urllib.request.urlopen('http://host.docker.internal:{port}/',timeout=5).status)"],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.strip(), "200", out.stderr[-300:])

    def test_no_secrets_env_or_docker_socket(self):
        token = f"secret-{uuid.uuid4().hex}"
        with patch.dict(os.environ, {"JARVIS_SANDBOX_CANARY": token, "JARVIS_INTERNAL_TOKEN": token}):
            r = run("env; ls -la /var/run/docker.sock /run/docker.sock 2>&1")
        self.assertNotIn(token, r.stdout)
        self.assertEqual(r.stdout.count("No such file or directory"), 2, r.stdout)

    def test_a_fork_bomb_is_contained(self):
        started = time.time()
        r = run(":(){ :|:& };:", timeout=10, pids=64)
        self.assertLess(time.time() - started, 60)
        self.assertNotEqual(r.exit_code, 0)
        after = run("echo alive")
        self.assertEqual(after.stdout.strip(), "alive", "the machine still runs sandboxes afterwards")

    def test_memory_is_capped(self):
        r = run("python -c \"b = bytearray(1024 * 1024 * 1024); print('GOT 1GB')\"", memory="128m", timeout=60)
        self.assertNotIn("GOT 1GB", r.stdout)
        self.assertEqual(r.exit_code, 137, r.stderr)

    def test_a_hung_run_is_killed_on_time_and_leaves_no_container(self):
        started = time.time()
        r = run("sleep 300", timeout=3)
        self.assertLess(time.time() - started, 30)
        self.assertEqual(r.exit_code, 137)
        self.assertIn("time or memory limit", r.stderr)
        left = subprocess.run(["docker", "ps", "-aq", "--filter", f"label={sandbox.LABEL}"],
                              capture_output=True, text=True).stdout.strip()
        self.assertEqual(left, "")


@unittest.skipUnless(DOCKER_UP, "Docker is not running")
class WorkspaceTests(unittest.TestCase):

    def test_changes_come_back_as_a_diff_and_the_copy_is_gone(self):
        seen = []
        real_mkdtemp = tempfile.mkdtemp
        with patch("core.sandbox.tempfile.mkdtemp", side_effect=lambda **kw: seen.append(real_mkdtemp(**kw)) or seen[-1]):
            r = run("printf 'one\\nTWO\\n' > a.txt && echo new > sub/b.txt && rm c.txt",
                    files={"a.txt": "one\ntwo\n", "c.txt": "bye\n", "sub/keep.txt": "same\n"})
        self.assertEqual(r.exit_code, 0, r.stderr)
        self.assertEqual(r.changes, [{"path": "a.txt", "status": "modified"}, {"path": "c.txt", "status": "deleted"},
                                     {"path": "sub/b.txt", "status": "added"}])
        self.assertIn("-two\n+TWO", r.diff)
        self.assertFalse(os.path.exists(seen[0]), "the workspace copy is deleted")

    def test_a_copied_folder_leaves_out_links_and_repo_internals(self):
        src = Path(tempfile.mkdtemp(prefix="jarvis-src-"))
        self.addCleanup(shutil.rmtree, src, True)
        (src / "main.py").write_text("print('hi')\n")
        (src / ".git").mkdir()
        (src / ".git" / "config").write_text("x")
        outside = Path(tempfile.mkdtemp(prefix="jarvis-out-"))
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "private.txt").write_text("private")
        linked = False
        try:
            os.symlink(outside / "private.txt", src / "link.txt")
            linked = True
        except OSError:
            pass  # Windows without symlink rights; the rest still runs
        r = run("find . -type f | sort; python main.py", source_dir=str(src))
        self.assertIn("./main.py", r.stdout)
        self.assertIn("hi", r.stdout)
        self.assertNotIn(".git", r.stdout)
        if linked:
            self.assertNotIn("link.txt", r.stdout)

    def test_paths_outside_the_workspace_are_refused(self):
        for bad in ("../escape.txt", "/etc/passwd", "C:/Windows/x", "a/../../b"):
            with self.assertRaises(ValueError, msg=bad):
                run("true", files={bad: "x"})


class RefusalTests(unittest.TestCase):

    def test_without_docker_it_refuses_rather_than_running_on_the_host(self):
        async def down(*args, **kw):
            return 1, "", "error during connect"
        with patch("core.sandbox._docker", side_effect=down), \
             patch("asyncio.create_subprocess_exec") as spawn, patch("asyncio.create_subprocess_shell") as shell:
            with self.assertRaises(sandbox.SandboxUnavailable):
                run("echo should-not-run")
            spawn.assert_not_called()
            shell.assert_not_called()

    def test_every_hardening_flag_is_present(self):
        args = sandbox.hardening_args("512m", "1", 128)
        pairs = {args[i]: args[i + 1] for i in range(len(args) - 1)}
        self.assertEqual(pairs["--network"], "none")
        self.assertEqual(pairs["--cap-drop"], "ALL")
        self.assertEqual(pairs["--security-opt"], "no-new-privileges")
        self.assertEqual(pairs["--user"], "65534:65534")
        self.assertEqual(pairs["--memory"], pairs["--memory-swap"])
        self.assertIn("--read-only", args)
        self.assertIn("@sha256:", sandbox.IMAGE, "the image is pinned by digest")


def _fetch_script(targets):
    """A probe run inside a networked sandbox: fetch each URL through the
    proxy the run is given, print what happened."""
    return ("import urllib.request, urllib.error\n"
            f"for url in {targets!r}:\n"
            "    try:\n"
            "        r = urllib.request.urlopen(url, timeout=20)\n"
            "        print('OK', r.status, url)\n"
            "    except urllib.error.HTTPError as e:\n"
            "        print('HTTP', e.code, url, e.read()[:200].decode(errors='replace').strip())\n"
            "    except Exception as e:\n"
            "        print('ERR', type(e).__name__, url, str(e)[:120])\n")


@unittest.skipUnless(DOCKER_UP, "Docker is not running")
class EgressTests(unittest.TestCase):
    """A networked run (network=True) reaches the public internet only through
    core/sandbox_egress.py's filter, and nothing on this computer or its
    network. Needs internet access for the public-site checks."""

    def fetch(self, targets):
        r = run("python probe.py", files={"probe.py": _fetch_script(targets)}, network=True, timeout=120)
        self.assertEqual(r.exit_code, 0, r.stderr)
        return {line.split()[2 if line.startswith(("OK", "HTTP", "ERR")) else 0]: line
                for line in r.stdout.splitlines() if line.startswith(("OK", "HTTP", "ERR"))}

    def test_public_sites_load_over_https_and_http(self):
        out = self.fetch(["https://example.com/", "http://example.com/"])
        self.assertTrue(out["https://example.com/"].startswith("OK 200"), out)
        self.assertTrue(out["http://example.com/"].startswith("OK 200"), out)

    def test_every_private_or_local_destination_is_refused_on_allowed_ports(self):
        targets = ["http://host.docker.internal/", "https://host.docker.internal/",  # this computer
                   "http://127.0.0.1/", "http://localhost/", "http://[::1]/",          # the filter's own loopback
                   "http://192.168.65.254/", "http://172.17.0.1/", "http://10.0.0.1/", "http://192.168.1.1/",
                   "http://169.254.169.254/latest/meta-data/",                         # cloud metadata
                   "http://100.100.100.100/",                                          # Tailscale
                   "http://127.0.0.1.nip.io/"]                                         # a public name for a private address
        out = self.fetch(targets)
        for url in targets:
            if url.startswith("https"):  # a refused tunnel shows only its status; the reason is in the log
                self.assertIn("Tunnel connection failed: 403", out[url])
            elif "nip.io" in url and "cannot resolve" in out[url]:
                pass  # many home routers drop public answers that point at private addresses; refused either way
            elif url.split("/")[2].strip("[]") in ("127.0.0.1", "localhost", "::1"):
                # Since 2026-10-16 a loopback name is a local app on this computer, reachable only on a port a
                # person approved for a computer preview (core/sandbox_egress.py LOCAL_HOSTS); none is approved here.
                host = url.split("/")[2].strip("[]")
                self.assertTrue(out[url].startswith("HTTP 403") and f"local app at {host}:80 is not approved" in out[url], out[url])
            else:
                self.assertTrue(out[url].startswith("HTTP 403") and "private or local" in out[url], out[url])
        from core import sandbox_egress
        log = subprocess.run(["docker", "logs", sandbox_egress.PROXY_NAME], capture_output=True, text=True).stdout
        self.assertIn("BLOCKED host.docker.internal is a private or local address", log)
        self.assertNotIn("ALLOWED CONNECT host.docker.internal", log)

    def test_other_ports_are_refused_even_for_this_computer(self):
        server, port = _host_http_server()
        self.addCleanup(server.server_close)  # runs after shutdown (cleanups run last-in, first-out)
        self.addCleanup(server.shutdown)
        out = self.fetch([f"http://host.docker.internal:{port}/", "http://example.com:8080/"])
        for line in out.values():
            self.assertIn("is not 80 or 443", line)

    def test_a_redirect_to_a_private_address_is_refused(self):
        """The redirect comes from a server inside the run itself (no public site, no internet needed).
        Its own address is exempted from the proxy for the first hop only; the address it redirects
        to goes through the proxy like any new request and is refused."""
        script = (
                  "import os, threading, http.server, urllib.request, urllib.error\n"
                  "class H(http.server.BaseHTTPRequestHandler):\n"
                  "    def do_GET(self):\n"
                  "        self.send_response(302); self.send_header('Location', 'http://127.0.0.1/'); self.end_headers()\n"
                  "    log_message = lambda *a: None\n"
                  "srv = http.server.HTTPServer(('127.0.0.1', 8099), H)\n"
                  "threading.Thread(target=srv.serve_forever, daemon=True).start()\n"
                  "os.environ['no_proxy'] = os.environ['NO_PROXY'] = '127.0.0.1:8099'\n"
                  "try:\n"
                  "    r = urllib.request.urlopen('http://127.0.0.1:8099/', timeout=20)\n"
                  "    print('OK', r.status, r.url)\n"
                  "except urllib.error.HTTPError as e:\n"
                  "    print('HTTP', e.code, e.url, e.read()[:200].decode(errors='replace').strip())\n"
                  "except Exception as e:\n"
                  "    print('ERR', type(e).__name__, str(e)[:120])\n")
        r = run("python probe.py", files={"probe.py": script}, network=True, timeout=60)
        self.assertEqual(r.exit_code, 0, r.stderr)
        line = next(l for l in r.stdout.splitlines() if l.startswith(("OK", "HTTP", "ERR")))
        # The redirect's target is this computer's loopback: refused as an unapproved local app (see above).
        self.assertTrue(line.startswith("HTTP 403") and "local app at 127.0.0.1:80 is not approved" in line, line)

    def test_no_way_out_but_the_filter(self):
        r = run("getent hosts example.com || echo NO-DNS; "
                "env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy python -c \""
                "import socket\n"
                "for h in ('1.1.1.1', '93.184.215.14'):\n"
                "    try: socket.create_connection((h, 443), timeout=3); print('REACHED', h)\n"
                "    except OSError as e: print('blocked', h, e)\"",
                network=True, timeout=60)
        self.assertIn("NO-DNS", r.stdout)
        self.assertNotIn("REACHED", r.stdout)

    def test_control_only_the_address_rule_stops_the_filter_reaching_this_computer(self):
        """The filter's own container can open a connection to this computer;
        what stops a sandboxed run getting there through it is the address rule."""
        server, port = _host_http_server()
        self.addCleanup(server.server_close)  # runs after shutdown (cleanups run last-in, first-out)
        self.addCleanup(server.shutdown)
        from core import sandbox_egress
        run("true", network=True)  # the filter is up
        out = subprocess.run(["docker", "exec", sandbox_egress.PROXY_NAME, "python", "-c",
                              f"import socket; socket.create_connection(('host.docker.internal', {port}), timeout=5); print('REACHED')"],
                             capture_output=True, text=True, timeout=60)
        self.assertIn("REACHED", out.stdout, out.stderr[-300:])

    def test_the_filter_itself_is_hardened(self):
        from core import sandbox_egress
        run("true", network=True)
        info = subprocess.run(["docker", "inspect", sandbox_egress.PROXY_NAME, "--format",
                               "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}} {{.HostConfig.SecurityOpt}}"],
                              capture_output=True, text=True).stdout.strip()
        self.assertEqual(info, "true [ALL] 65534:65534 [no-new-privileges]")
        internal = subprocess.run(["docker", "network", "inspect", sandbox_egress.NETWORK, "--format", "{{.Internal}}"],
                                  capture_output=True, text=True).stdout.strip()
        self.assertEqual(internal, "true")

    def test_a_run_without_network_is_still_sealed(self):
        r = run("python -c \"import os; print(sorted(os.listdir('/sys/class/net')))\"; env | grep -i proxy || echo NO-PROXY")
        self.assertIn("['lo']", r.stdout)
        self.assertIn("NO-PROXY", r.stdout)


@unittest.skipUnless(DOCKER_UP, "Docker is not running")
class BrowseTests(unittest.TestCase):
    """Step 3: the read-only browser (core/sandbox_browser.py) and the
    prompted internet option of run_code. Needs internet access."""

    def browse(self, url):
        from core import sandbox_browser
        return asyncio.run(sandbox_browser.browse(url))

    def test_a_public_page_comes_back_as_title_text_and_links(self):
        page = self.browse("https://example.com/")
        self.assertIsNone(page["error"])
        self.assertEqual(page["title"], "Example Domain")
        self.assertIn("documentation examples", page["text"])
        self.assertTrue(page["links"] and page["links"][0]["url"].startswith("https://"), page["links"])

    def test_this_computer_and_the_browsers_own_loopback_are_refused(self):
        for url in ("http://host.docker.internal/", "http://127.0.0.1/", "http://localhost:80/", "http://169.254.169.254/"):
            page = self.browse(url)
            # The filter's own refusal, not just an empty page: without
            # --proxy-bypass-list=<-loopback> Chromium reaches its own
            # loopback directly and merely finds nothing there.
            self.assertTrue((page["error"] or "").startswith("refused:"), f"{url}: {page}")
            self.assertEqual(page["text"], "")
        self.assertIsNotNone(self.browse("https://host.docker.internal/")["error"])

    def test_only_web_addresses_are_accepted_and_nothing_is_left_running(self):
        from core import sandbox_browser
        for bad in ("file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "example.com"):
            with self.assertRaises(ValueError, msg=bad):
                self.browse(bad)
        self.browse("https://example.com/")
        left = subprocess.run(["docker", "ps", "-aq", "--filter", f"label={sandbox.LABEL}"],
                              capture_output=True, text=True).stdout.strip()
        self.assertEqual(left, "", "each browser is thrown away with its container")
        self.assertIn("@sha256:", sandbox_browser.BROWSER_IMAGE)

    def test_a_long_page_is_cut_cleanly(self):
        page = self.browse("https://en.wikipedia.org/wiki/Docker_(software)")
        self.assertIsNone(page["error"])
        self.assertTrue(page["text"].endswith("page text cut here"))
        self.assertLessEqual(len(page["links"]), 60)


    def test_browse_is_offered_to_every_model_but_codex_and_claude_needs_no_prompt(self):
        from core.brain import Brain
        from core.external_brain import ExternalBrain
        self.assertIn("browse", [t["function"]["name"] for t in ExternalBrain("http://x", "m", None).tools])
        _, allowed, _ = Brain(vault_dir=tempfile.gettempdir())._tool_config()
        self.assertIn("mcp__hive_mind__browse", allowed)
        text = asyncio.run(tool_registry.call("browse", {"url": "https://example.com/"},
                                              tool_registry.ToolContext("sbx-chat"), tool_registry.OPENAI))
        self.assertTrue(text.startswith("Title: Example Domain"), text[:200])

    def test_run_code_with_internet_asks_first_and_nobody_to_ask_means_no(self):
        from core import permissions
        spawned = []
        real_run = sandbox.run

        async def watched(*a, **kw):
            spawned.append(kw.get("network"))
            return await real_run(*a, **kw)
        fetch = {"command": "python get.py", "internet": True,
                 "files": {"get.py": "import urllib.request as u; print(u.urlopen('https://example.com/', timeout=20).status)"}}
        with patch("core.sandbox.run", side_effect=watched):
            refused = call(fetch)  # no chat window: the broker cannot ask
            self.assertTrue(refused.startswith("Not run:"), refused)
            self.assertEqual(spawned, [], "a refused run never starts")
            with patch.object(permissions, "decide", return_value=permissions.Decision("allow")) as asked:
                allowed = call(fetch)
            self.assertIn("200", allowed)
            self.assertEqual(asked.call_args.kwargs["tool"], "run_code_internet")
            self.assertEqual(spawned, [True])
            with patch.object(permissions, "decide") as not_asked:
                offline = call({"command": "echo offline"})
            not_asked.assert_not_called()
        self.assertIn("offline", offline)


@unittest.skipUnless(DOCKER_UP, "Docker is not running")
class ComputerLiveTests(unittest.TestCase):
    """The long-lived browser uses the same sealed network as browse."""

    def test_recording_labels_and_private_text_stays_in_container(self):
        from core import computer, permissions
        from core.computer_driver import SOURCE
        # example.com has no password field. Set content inside the driver after
        # opening it, so privacy is checked without a secret on a public site.
        fixture = SOURCE.replace("            if action == 'state':", """            if action == 'recording_fixture':
                await page.set_content('<a href="#details">More information</a><label for="search">Search</label><input id="search"><label for="password">Password</label><input id="password" type="password">')
                return {'url': page.url, 'title': await page.title()}
            if action == 'recording_target':
                box = await page.locator(cmd['selector']).bounding_box()
                x, y = box['x'] + box['width']/2, box['y'] + box['height']/2
                if DESKTOP:
                    origin = await page.evaluate('({x:screenX+(outerWidth-innerWidth)/2,y:screenY+outerHeight-innerHeight})')
                    x, y = x + origin['x'], y + origin['y']
                return {'x': int(x), 'y': int(y)}
            if action == 'state':""", 1)

        async def check():
            manager = computer.ComputerManager()
            owner = "chat:live-recording"
            ctx = tool_registry.ToolContext(session_id="live-recording", is_admin=True)
            try:
                with patch("core.computer.SOURCE", fixture), \
                     patch("core.computer.permissions.decide", return_value=permissions.Decision("allow")):
                    await manager.act(owner, "open", {"url": "https://example.com/"}, ctx)
                    c = manager._computers[owner]
                    await manager._command(c, "recording_fixture")
                    manager.takeover(owner)
                    await manager.start_recording(owner)
                    for selector in ("a", "#search", "#password"):
                        target = await manager._command(c, "recording_target", selector=selector)
                        await manager.person_input(owner, "click", {key: target[key] for key in ("x", "y")})
                        if selector != "a":
                            await manager.person_input(owner, "type", {"text": "private-live-secret" if selector == "#password" else "kairos"})
                        await asyncio.sleep(0.1)
                    steps = await manager.stop_recording(owner)
                    clicks = [step for step in steps if step["kind"] == "click"]
                    self.assertTrue(any(step.get("element", {}).get("label") == "More information" for step in clicks), steps)
                    self.assertTrue(any(step.get("text") == "kairos" for step in steps), steps)
                    private = [step for step in steps if step.get("private") and step["kind"] == "type"]
                    self.assertTrue(private, steps)
                    self.assertTrue(all("text" not in step for step in private))
                    self.assertNotIn("private-live-secret", __import__("json").dumps(steps))
                    self.assertFalse(any("screenshot" in step or "image" in step for step in steps))
            finally:
                await manager.close_all()
        asyncio.run(check())

    def test_container_seal_and_filtered_egress(self):
        from core import computer
        async def check():
            manager = computer.ComputerManager()
            try:
                c = await manager._get("chat:live-seal")
                # `docker run` returns before the container exists; the driver's
                # first answer proves it is up.
                await manager._command(c, "state")
                inspect = subprocess.run(["docker", "inspect", c.name], capture_output=True, text=True, check=True)
                data = __import__("json").loads(inspect.stdout)[0]
                self.assertEqual(data["Mounts"], [], "a blank chat mounts no host path")
                self.assertFalse(data["HostConfig"]["PortBindings"])
                self.assertTrue(data["HostConfig"]["ReadonlyRootfs"])
                self.assertEqual(data["Config"]["User"], "65534:65534")
                ports = subprocess.run(["docker", "port", c.name], capture_output=True, text=True)
                self.assertEqual(ports.stdout.strip(), "")
                for url in ("http://127.0.0.1/", "http://10.0.0.1/"):
                    script = ("import http.client; c=http.client.HTTPConnection('jarvis-sbx-egress',8888,timeout=10); "
                              f"c.request('GET',{url!r}); print(c.getresponse().status)")
                    attempt = subprocess.run(["docker", "exec", c.name, "python3", "-c", script],
                                             capture_output=True, text=True, timeout=20)
                    self.assertEqual(attempt.returncode, 0, attempt.stderr)
                    self.assertEqual(attempt.stdout.strip(), "403", url)
                from services.agent_service import agent_service
                agent = agent_service.create("Live profile check", keep_signed_in=True)
                kept = await manager._get("agent:" + agent["id"])
                await manager._command(kept, "state")
                profile = subprocess.run(["docker", "inspect", kept.name], capture_output=True, text=True, check=True)
                mounts = __import__("json").loads(profile.stdout)[0]["Mounts"]
                self.assertEqual(len(mounts), 1)
                self.assertEqual(mounts[0]["Source"], str(computer.profiles_dir() / agent["id"]))
                await manager.stop("agent:" + agent["id"])
                agent_service.delete(agent["id"])
            finally:
                await manager.close_all()
        asyncio.run(check())

    def test_open_read_click_done(self):
        from core import computer, permissions
        from core.turn_taint import TurnTaint
        async def check():
            manager = computer.ComputerManager()
            ctx = tool_registry.ToolContext(session_id="live-computer", is_admin=True, turn_taint=TurnTaint())
            try:
                with patch("core.computer.permissions.decide", return_value=permissions.Decision("allow")):
                    await manager.act("chat:live-computer", "open", {"url": "https://example.com/"}, ctx)
                    read = await manager.act("chat:live-computer", "read", {}, ctx)
                    self.assertIn("Example Domain", read["text"])
                    self.assertIn("[r1:1]", read["text"])  # refs are snapshot-scoped (cua upgrade 5.2)
                    clicked = await manager.act("chat:live-computer", "click", {"ref": "1"}, ctx)
                    self.assertNotIn("URL: https://example.com/ |", clicked["text"])
                    await manager.act("chat:live-computer", "done", {}, ctx)
                    self.assertEqual(manager.running(), [])
            finally:
                await manager.close_all()
        asyncio.run(check())


STALE_PAGE = ("<ul id=list><li><button>Archive</button></li><li><button>Keep</button></li></ul><p id=out></p>"
              "<script>setTimeout(() => { document.getElementById('list').innerHTML = "
              "'<li><button onclick=\"out.textContent=`deleted`\">Delete item</button></li><li><button>Archive</button></li>'"
              " }, 1200)</script>")


@unittest.skipUnless(DOCKER_UP, "Docker is not running")
class ComputerContractLiveTests(unittest.TestCase):
    """The action contract (vault: Agents - Computer-Use Upgrade from cua)."""

    def fixture_source(self, body):
        from core.computer_driver import SOURCE
        anchor = "page = context.pages[0] if context.pages else await context.new_page()\n"
        return SOURCE.replace(anchor, anchor + "        await page.route('https://example.com/**', "
                              f"lambda route: route.fulfill(body={body!r}, content_type='text/html'))\n", 1)

    def test_a_ref_from_an_earlier_read_never_clicks_what_replaced_it(self):
        from core import computer, permissions
        import re as regex

        async def check():
            manager = computer.ComputerManager()
            owner = "chat:live-stale"
            ctx = tool_registry.ToolContext(session_id="live-stale", is_admin=True)
            try:
                with patch("core.computer.SOURCE", self.fixture_source(STALE_PAGE)), \
                     patch("core.computer.permissions.decide", return_value=permissions.Decision("allow")):
                    await manager.act(owner, "open", {"url": "https://example.com/"}, ctx)
                    first = await manager.act(owner, "read", {}, ctx)
                    archive = regex.search(r"\[([^\]]+)\] button Archive", first["text"]).group(1)
                    await asyncio.sleep(2)
                    second = await manager.act(owner, "read", {}, ctx)
                    self.assertIn("Delete item", second["text"])
                    try:
                        clicked = await manager.act(owner, "click", {"ref": archive}, ctx)
                    except ValueError as refused:
                        self.assertEqual(getattr(refused, "code", None), "stale_ref")
                        self.assertIn("older read", str(refused))
                    else:
                        self.fail(f"a ref from the earlier read was used: {clicked['text']}")
                    c = manager._computers[owner]
                    page = await manager._command(c, "verify", expect={"text_absent": "deleted"})
                    self.assertTrue(page["checks"][0]["met"], "the replacing button was pressed")
            finally:
                await manager.close_all()
        asyncio.run(check())

    def bench(self, check):
        """Run `check(manager, act)` against fixture pages served inside the
        driver (the benchmark's own mechanism; no network, no approval)."""
        from core import computer
        from core.turn_taint import TurnTaint

        async def run():
            manager = computer.ComputerManager(fixtures=CONTRACT_PAGES, approved_hosts=("bench.kairos.test",))
            ctx = tool_registry.ToolContext(session_id="live-contract", is_admin=True, turn_taint=TurnTaint())
            try:
                with patch("core.computer.permissions.decide", side_effect=AssertionError("nothing here may ask")):
                    await check(manager, lambda action, **args: manager.act("chat:live-contract", action, args, ctx))
            finally:
                await manager.close_all()
        asyncio.run(run())

    def test_a_five_field_form_fills_in_one_call_and_verify_reports_both_outcomes(self):
        import re as regex

        async def check(manager, act):
            await act("open", url="https://bench.kairos.test/form.html")
            read = await act("read", query="field")
            refs = dict(regex.findall(r"\[(r\d+:\d+)\] input (\w+ field)", read["text"]))
            refs = {label: ref for ref, label in refs.items()}
            self.assertEqual(len(refs), 5, read["text"])
            values = {"First field": "Ada", "Last field": "Lovelace", "Email field": "ada@example.com",
                      "City field": "London", "Notes field": "Engines"}
            calls_before = len(manager._computers["chat:live-contract"].pending)
            done = await act("steps", steps=[{"action": "type", "ref": refs[label], "text": value}
                                              for label, value in values.items()])
            self.assertEqual(calls_before, 0)
            self.assertIn("Steps: 5 of 5 ran.", done["text"])
            self.assertIn("Changes since", done["text"])
            self.assertEqual(len(done["images"]), 1, "one observation at the end")
            met = await act("verify", expect={"text_present": "Form ready", "url_contains": "form.html"})
            self.assertTrue(met["met"], met["text"])
            self.assertIn("Verify: met.", met["text"])
            missed = await act("verify", expect={"text_present": "Submitted", "element": {"role": "button", "name": "Continue"}})
            self.assertFalse(missed["met"])
            self.assertIn("text_present \"Submitted\": not met (not on the page)", missed["text"])
            self.assertIn("element", missed["text"])
            self.assertIn("1 matching element", missed["text"])
        self.bench(check)

    def test_a_buy_button_in_step_three_stops_the_batch_after_two(self):
        import re as regex

        async def check(manager, act):
            await act("open", url="https://bench.kairos.test/form.html")
            read = await act("read")
            ref = lambda label: regex.search(r"\[(r\d+:\d+)\] [^\n]*" + label, read["text"]).group(1)
            done = await act("steps", steps=[
                {"action": "type", "ref": ref("First field"), "text": "Ada"},
                {"action": "type", "ref": ref("Last field"), "text": "Lovelace"},
                {"action": "click", "ref": ref("Buy now")},
                {"action": "type", "ref": ref("City field"), "text": "never typed"}])
            self.assertEqual(done["code"], "person_only")
            self.assertTrue(done["text"].startswith("Stopped: at step 3 of 4. Steps: 2 of 4 ran."), done["text"])
            self.assertIn("Steps 1 to 2 already ran and were not undone.", done["text"])
            c = manager._computers["chat:live-contract"]
            state = await manager._command(c, "verify", expect={"text_absent": "Bought", "text_present": "Lovelace"})
            self.assertFalse(any(row["check"] == "text_absent" and not row["met"] for row in state["checks"]))
            filled = await act("read", query="City")
            self.assertNotIn("never typed", filled["text"])
            private = await act("steps", steps=[{"action": "type", "ref": regex.search(
                r"\[(r\d+:\d+)\] input[^\n]*Password", (await act("read")).get("text")).group(1), "text": "hunter2"}])
            self.assertEqual(private["code"], "private_field")
        self.bench(check)

    def test_a_diff_read_is_smaller_than_a_full_read(self):
        async def check(manager, act):
            await act("open", url="https://bench.kairos.test/long.html")
            full = await act("read")
            await act("click", ref=__import__("re").search(r"\[(r\d+:\d+)\] button Add a row", full["text"]).group(1))
            diff = await act("read", since="latest")
            self.assertIn("1 added", diff["text"])
            self.assertIn("Row 41", diff["text"])
            self.assertLess(len(diff["text"]), len(full["text"]) / 4, (len(diff["text"]), len(full["text"])))
            narrow = await act("read", query="Row 7")
            self.assertLess(len(narrow["text"]), len(full["text"]) / 4)
            self.assertIn("## Table", narrow["text"])
            await act("open", url="https://bench.kairos.test/form.html")
            moved = await act("read", since="latest")
            self.assertIn("Full read: the page navigated.", moved["text"])
        self.bench(check)


@unittest.skipUnless(DOCKER_UP, "Docker is not running")
class DesktopSemanticsLiveTests(unittest.TestCase):
    """Desktop read by AT-SPI under the same hardening (cua upgrade 5.3)."""

    def setUp(self):
        desktop = patch("core.computer._desktop_enabled", return_value=True)
        desktop.start()
        self.addCleanup(desktop.stop)

    def test_writer_menus_calc_cells_password_dialog_and_labels_guard(self):
        from core import computer, permissions
        from core.turn_taint import TurnTaint
        import re as regex

        async def check():
            manager = computer.ComputerManager()
            owner = "chat:live-a11y"
            taint = TurnTaint()
            ctx = tool_registry.ToolContext(session_id="live-a11y", is_admin=True, turn_taint=taint)
            act = lambda action, **args: manager.act(owner, action, args, ctx)

            async def read_until(pattern, **args):
                for _ in range(60):
                    try:
                        read = await act("read", desktop=True, **args)
                        if regex.search(pattern, read["text"]): return read
                    except ValueError:
                        pass
                    await asyncio.sleep(0.5)
                self.fail(f"never saw {pattern}: {read['text'][-1500:]}")

            def ref(read, pattern):
                return regex.search(r"\[(d\d+:\d+)\] " + pattern, read["text"]).group(1)
            try:
                with patch("core.computer.permissions.decide", side_effect=AssertionError("nothing here may ask")):
                    await act("launch", app="writer")
                    writer = await read_until(r"\] menu File\b", max_elements=200)
                    self.assertTrue(taint.tainted, "desktop labels taint the turn")
                    self.assertIn("UNTRUSTED", writer["text"])
                    self.assertRegex(writer["text"], r"\] menu Edit\b")
                    self.assertEqual(len(regex.findall(r"\] menu File\b", writer["text"])), 1, "one menu bar, not two")
                    self.assertRegex(writer["text"], r"\] (toggle|push) button Bold", "toolbar rows")
                    self.assertRegex(writer["text"], r"Desktop read completed: Untitled 1 . LibreOffice Writer \(soffice\)")
                    opened = await act("click", ref=ref(writer, r"menu Edit\b"))
                    self.assertIn("by action", opened["text"])
                    menu = await read_until(r"\] menu Track Changes")
                    await act("click", ref=ref(menu, r"menu Track Changes"))
                    sub = await read_until(r"\] (check )?menu item Protect\.\.\.", query="Protect")
                    await act("click", ref=ref(sub, r"(?:check )?menu item Protect\.\.\."))
                    dialog = await read_until(r"\] password text")
                    secret = ref(dialog, r"password text")
                    refused = await act("type", ref=secret, text="private-desktop-secret")
                    self.assertEqual(refused["code"], "private_field", refused["text"])
                    keyed = await act("type", desktop=True, text="private-desktop-secret")
                    self.assertEqual(keyed["code"], "private_field", keyed["text"])
                    await act("key", desktop=True, key="Escape")
                    files = await read_until(r"\] menu File\b")
                    await act("click", ref=ref(files, r"menu File\b"))
                    file_menu = await read_until(r"\] menu Send\b")
                    stopped = await act("click", ref=ref(file_menu, r"menu Send\b"))
                    self.assertEqual(stopped["code"], "person_only", stopped["text"])
                    self.assertIn("Stopped before pressing 'Send' on the desktop (soffice)", stopped["text"])
                    await act("key", desktop=True, key="Escape")
                    await act("launch", app="calc")
                    sheet = await read_until(r"\] table cell B2", query="B2")
                    typed = await act("type", ref=ref(sheet, r"table cell B2"), text="42")
                    self.assertIn("by focus", typed["text"])
                    await act("key", desktop=True, key="Enter")
                    landed = await read_until(r"table cell B2 =\"42\"", query="B2")
                    self.assertIn('=\"42\"', landed["text"])
                    stale = await act("read", desktop=True, since="latest")
                    self.assertIn("Changes since", stale["text"])
                    with self.assertRaises(computer.ComputerRefusal) as old:
                        await act("click", ref=ref(writer, r"menu Edit\b"))
                    self.assertEqual(old.exception.code, "stale_ref")
                    met = await act("verify", desktop=True, expect={"element": {"role": "cell", "name": "B2"}, "text_present": "42"})
                    self.assertTrue(met["met"], met["text"])
                    c = manager._computers[owner]
                    seal = subprocess.run(["docker", "exec", c.name, "sh", "-c", "id -u; touch /etc/owned 2>/dev/null && echo WRITABLE"],
                                          capture_output=True, text=True, timeout=10)
                    self.assertEqual(seal.stdout.strip(), "65534")
                    data = __import__("json").loads(subprocess.run(["docker", "inspect", c.name], capture_output=True, text=True, check=True).stdout)[0]
                    self.assertTrue(data["HostConfig"]["ReadonlyRootfs"])
                    self.assertEqual(data["HostConfig"]["CapDrop"], ["ALL"])
            finally:
                await manager.close_all()
        asyncio.run(check())


@unittest.skipUnless(DOCKER_UP, "Docker is not running")
class TrajectoryLiveTests(unittest.TestCase):
    """An agent's computer run kept as evidence (cua upgrade 5.4)."""

    def test_an_agent_run_keeps_step_folders_markers_and_no_private_text(self):
        from core import computer, computer_trajectory, runs
        from core.turn_taint import TurnTaint
        from services.agent_service import agent_service
        from PIL import Image
        import io, json as jsonlib, re as regex
        root = Path(tempfile.mkdtemp(prefix="trajectories-"))
        agent = agent_service.create("Trajectory check")
        owner = "agent:" + agent["id"]

        async def check():
            manager = computer.ComputerManager(fixtures=CONTRACT_PAGES, approved_hosts=("bench.kairos.test",), trajectories=root)
            ctx = tool_registry.ToolContext(agent_id=agent["id"], is_admin=True, turn_taint=TurnTaint())
            context = runs.RunContext("task", agent_id=agent["id"])
            token = runs.CURRENT.set(context)
            act = lambda action, **args: manager.act(owner, action, args, ctx)
            try:
                await act("open", url="https://bench.kairos.test/send.html")
                read = await act("read")
                ref = lambda label: regex.search(r"\[(r\d+:\d+)\] [^\n]*" + label, read["text"]).group(1)
                await act("type", ref=ref("To field"), text="ada@example.com")
                refused = await act("type", ref=ref("Password"), text="never-kept-secret")
                self.assertEqual(refused["code"], "private_field")
                await act("click", ref=ref("Preview"))
                stopped = await act("click", ref=ref("Send"))
                self.assertEqual(stopped["code"], "person_only")
                return context.run_id
            finally:
                runs.CURRENT.reset(token)
                await manager.close_all()
        try:
            run_id = asyncio.run(check())
            folder = root / run_id
            names = sorted(path.name for path in folder.iterdir())
            self.assertEqual(names, ["meta.json", "step-0001", "step-0002", "step-0003", "step-0004", "step-0005", "step-0006"])
            self.assertEqual(jsonlib.loads((folder / "meta.json").read_text())["owner"], owner)
            steps = computer_trajectory.steps(run_id, root)
            self.assertEqual([s["action"] for s in steps], ["open", "read", "type", "type", "click", "click"])
            self.assertTrue((folder / "step-0002" / "state.json").exists(), "a read keeps its rows")
            private = steps[3]
            self.assertEqual(private["arguments"]["text"], "(private field)")
            self.assertEqual(private["images"], [])
            self.assertEqual(private["evidence"]["not_kept"]["after.jpg"], "private field")
            self.assertNotIn("never-kept-secret", "".join(p.read_text(errors="ignore") for p in folder.rglob("*.json")))
            preview = steps[4]
            self.assertEqual(preview["images"], ["before.jpg", "after.jpg", "marker.jpg"])
            point = preview["point"]
            with Image.open(folder / "step-0005" / "marker.jpg") as marker:
                red, green, blue = marker.convert("RGB").getpixel((point["x"], point["y"]))
            self.assertGreater(red, 150); self.assertLess(green, 90); self.assertLess(blue, 90)
            with Image.open(folder / "step-0005" / "before.jpg") as before:
                self.assertEqual(before.size, (1280, 800))
            self.assertEqual(steps[5]["code"], "person_only")
            self.assertIn("before.jpg", steps[5]["images"])
            self.assertEqual(steps[2]["arguments"]["text"], "ada@example.com")
            shaped = computer_trajectory.skill_steps(run_id, root)
            self.assertEqual([s["kind"] for s in shaped], ["open", "type", "click"])
            self.assertEqual(shaped[2]["element"]["label"], "Preview")
            with patch.object(agent_service, "_require", return_value={}), \
                 patch.object(computer_trajectory, "ROOT", root):
                agent_service.forget_logins(agent["id"])
            self.assertFalse(folder.exists(), "Forget logins deletes the agent's steps")
        finally:
            agent_service.delete(agent["id"])
            shutil.rmtree(root, ignore_errors=True)


CONTRACT_PAGES = {
    "/send.html": {"body": "<title>Mail</title><h1>New message</h1><label>To field <input aria-label='To field'></label>"
                   "<label>Password <input type=password aria-label='Password'></label>"
                   "<p id=state>Draft</p><button onclick=\"state.textContent='Previewed'\">Preview</button>"
                   "<div style='height:300px'></div><button onclick=\"state.textContent='Sent'\">Send</button>"},
    "/form.html": {"body": "<title>Form</title><h1>Sign up</h1><form onsubmit='return false'>"
                   + "".join(f"<label>{name} field <input aria-label='{name} field' name='{name.lower()}'></label><br>"
                             for name in ("First", "Last", "Email", "City", "Notes"))
                   + "<label>Password <input type=password aria-label='Password'></label>"
                   "<button type=button>Continue</button><button type=button onclick=\"document.body.append('Bought')\">"
                   "Buy now</button></form><p>Form ready</p>"},
    "/long.html": {"body": "<title>Long</title><h1>Table</h1><button onclick=\"const r=document.createElement('a');"
                   "r.href='#41';r.textContent='Row 41 link';document.body.append(r)\">Add a row</button>"
                   + "".join(f"<p><a href='#{i}'>Row {i} link</a> value {i * 7} and some longer descriptive text "
                             f"so the page is like a real one</p>" for i in range(1, 41))},
}


@unittest.skipUnless(DOCKER_UP, "Docker is not running")
class DesktopLiveTests(ComputerLiveTests):
    """The desktop inherits the browser's profile and containment checks."""

    def setUp(self):
        desktop = patch("core.computer._desktop_enabled", return_value=True)
        desktop.start()
        self.addCleanup(desktop.stop)

    def test_editor_documents_display_and_web_hard_stop(self):
        from core import computer, permissions
        from core.computer_driver import SOURCE
        fixture = SOURCE.replace("        history = {}", "        await page.route('https://example.com/**', "
            "lambda route: route.fulfill(body=\"<button>Place order</button><button style='position:absolute;right:0;bottom:0' "
            "onclick='this.textContent=String(12345)'>Safe</button>\"))\n        history = {}", 1)
        self.assertNotEqual(fixture, SOURCE, "the fixture page must reach the driver")

        async def check():
            manager = computer.ComputerManager()
            ctx = tool_registry.ToolContext(session_id="live-desktop", is_admin=True)
            owner = "chat:live-desktop"
            try:
                with patch("core.computer.SOURCE", fixture), \
                     patch("core.computer.permissions.decide", return_value=permissions.Decision("allow")):
                    await manager.act(owner, "open", {"url": "https://example.com/"}, ctx)
                    c = manager._computers[owner]
                    self.assertTrue(manager.running()[0]["desktop"])
                    read = await manager.act(owner, "read", {}, ctx)
                    self.assertIn("Place order", read["text"])
                    stopped = await manager.act(owner, "click", {"ref": "1"}, ctx)
                    self.assertIn("Stopped before pressing 'Place order'", stopped["text"])
                    screen = await manager._command(c, "desktop_screenshot")
                    import base64, io
                    from PIL import Image
                    with Image.open(io.BytesIO(base64.b64decode(screen["screenshot"]))) as image:
                        self.assertEqual(image.format, "PNG")
                        self.assertEqual(image.size, (1280, 800))
                    page_screen = await manager._command(c, "screenshot")
                    with Image.open(io.BytesIO(base64.b64decode(page_screen["screenshot"]))) as image:
                        width, height = image.size
                    self.assertLessEqual(width, 1280)
                    self.assertLess(height, 800)
                    clicked = await manager.act(owner, "click", {"x": width - 10, "y": height - 10}, ctx)
                    self.assertNotIn("Stopped", clicked["text"])
                    self.assertIn("12345", (await manager.act(owner, "read", {}, ctx))["text"])
                    display = subprocess.run(["docker", "exec", "-e", "DISPLAY=:99", c.name, "xdotool", "getdisplaygeometry"],
                        capture_output=True, text=True, timeout=10)
                    self.assertEqual(display.returncode, 0, display.stderr)
                    self.assertEqual(display.stdout.strip(), "1280 800")
                    manager.takeover(owner)
                    await manager.start_recording(owner)
                    await manager._command(c, "launch", app="editor")
                    for _ in range(100):
                        window = (await manager._command(c, "focused_window"))["window"]
                        if "mousepad" in window["class"].lower(): break
                        await asyncio.sleep(0.1)
                    else: self.fail("the editor did not become the focused window")
                    windows = await manager._command(c, "windows")
                    self.assertTrue(any("mousepad" in item["class"].lower() and item["geometry"]["width"] > 0
                                        for item in windows["windows"]))
                    for kind, values in (("type", {"text": "Kairos desktop document"}), ("key", {"key": "Control+s"}),
                                         ("type", {"text": "/profile/Documents/desktop-check.txt"}), ("key", {"key": "Enter"})):
                        await manager.person_input(owner, kind, values)
                        await asyncio.sleep(0.3)
                    for _ in range(50):
                        saved = subprocess.run(["docker", "exec", c.name, "cat", "/profile/Documents/desktop-check.txt"],
                            capture_output=True, text=True, timeout=10)
                        if saved.returncode == 0: break
                        await asyncio.sleep(0.1)
                    self.assertEqual(saved.returncode, 0, saved.stderr)
                    self.assertEqual(saved.stdout.strip(), "Kairos desktop document")
                    steps = await manager.stop_recording(owner)
                    self.assertTrue(any(step.get("kind") == "launch" and step.get("app") == "editor" for step in steps))
                    self.assertTrue(any(step.get("text") == "Kairos desktop document" and
                                        "mousepad" in step.get("window", {}).get("class", "").lower() for step in steps))
                    manager.hand_back(owner)
                    await manager.act(owner, "launch", {"app": "calc"}, ctx)
                    for _ in range(100):
                        windows = (await manager._command(c, "windows"))["windows"]
                        if any("calc" in item["title"].lower() for item in windows): break
                        await asyncio.sleep(0.1)
                    else: self.fail("Calc did not open")
                    # Allow startup dialogs time to appear before checking the seed.
                    await asyncio.sleep(1)
                    windows = (await manager._command(c, "windows"))["windows"]
                    self.assertFalse(any("tip of the day" in item["title"].lower() for item in windows))
                    browsers = [item for item in windows if any(name in item["class"].lower()
                                for name in ("chromium", "chrome", "kairos-computer-browser"))]
                    self.assertTrue(browsers)
                    for item in browsers:
                        geometry = item["geometry"]
                        self.assertGreaterEqual(geometry["x"], 0)
                        self.assertGreaterEqual(geometry["y"], 0)
                        self.assertLessEqual(geometry["x"] + geometry["width"], 1280)
                        self.assertLessEqual(geometry["y"] + geometry["height"], 800)
                    root = subprocess.run(["docker", "exec", c.name, "sh", "-c",
                        "id -u; touch /etc/owned 2>/dev/null && echo WRITABLE; test -d /profile/Documents"],
                        capture_output=True, text=True, timeout=10)
                    self.assertEqual(root.stdout.strip(), "65534")
                    inspect = subprocess.run(["docker", "inspect", c.name], capture_output=True, text=True, check=True)
                    data = __import__("json").loads(inspect.stdout)[0]
                    self.assertEqual(data["HostConfig"]["Memory"], 2 * 1024 ** 3)
            finally:
                await manager.close_all()
        asyncio.run(check())


class ChangeSetTests(unittest.TestCase):
    """Sandbox edits to a folder wait as change sets until an admin applies
    them (core/sandbox_changes.py). Applies happen in a throwaway folder,
    never the real JARVIS one."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="jarvis-changes-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / ".git").mkdir()  # a development checkout; see test_an_installed_app_folder_is_refused
        (self.root / "a.py").write_text("print('old')\n", newline="")
        (self.root / "b.txt").write_text("keep\n", newline="")
        (self.root / "c.txt").write_text("bye\n", newline="")

    def recorded(self):
        from core import sandbox_changes
        result = run("printf \"print('new')\\n\" > a.py && mkdir -p new && echo made > new/n.txt && rm c.txt "
                     "&& python a.py", source_dir=str(self.root))
        self.assertEqual(result.exit_code, 0, result.stderr)
        change_id = sandbox_changes.record(result, "chat-1", root=str(self.root))
        self.assertIsNotNone(change_id)
        return change_id

    def apply(self, change_id):
        from core import sandbox_changes
        return sandbox_changes.apply(change_id, allowed_root=str(self.root))

    @unittest.skipUnless(DOCKER_UP, "Docker is not running")
    def test_a_run_becomes_a_change_set_and_applying_writes_exactly_it(self):
        from core import sandbox_changes
        change_id = self.recorded()
        summary = next(c for c in sandbox_changes.list_pending() if c["id"] == change_id)
        self.assertEqual(sorted((c["status"], c["path"]) for c in summary["changes"]),
                         [("added", "new/n.txt"), ("deleted", "c.txt"), ("modified", "a.py")],
                         "no __pycache__ clutter from running the code")
        self.assertIn("+print('new')", sandbox_changes.get(change_id)["diff"])
        self.assertEqual((self.root / "a.py").read_text(), "print('old')\n", "nothing applied until asked")
        self.apply(change_id)
        self.assertEqual((self.root / "a.py").read_bytes(), b"print('new')\n")
        self.assertEqual((self.root / "new" / "n.txt").read_bytes(), b"made\n")
        self.assertFalse((self.root / "c.txt").exists())
        self.assertEqual((self.root / "b.txt").read_text(), "keep\n")
        self.assertNotIn(change_id, [c["id"] for c in sandbox_changes.list_pending()], "an applied set is gone")
        self.assertEqual([p.name for p in self.root.rglob("*.tmp")], [], "no staging files left")

    @unittest.skipUnless(DOCKER_UP, "Docker is not running")
    def test_a_file_edited_since_the_run_blocks_the_whole_apply(self):
        from core import sandbox_changes
        change_id = self.recorded()
        (self.root / "a.py").write_text("print('edited by hand')\n", newline="")
        with self.assertRaises(sandbox_changes.Conflict) as caught:
            self.apply(change_id)
        self.assertIn("a.py", str(caught.exception))
        self.assertEqual((self.root / "a.py").read_text(), "print('edited by hand')\n")
        self.assertTrue((self.root / "c.txt").exists(), "nothing deleted")
        self.assertFalse((self.root / "new").exists(), "nothing added")
        self.assertIn(change_id, [c["id"] for c in sandbox_changes.list_pending()], "kept, so it can be discarded")

    @unittest.skipUnless(DOCKER_UP, "Docker is not running")
    def test_a_file_that_appeared_since_the_run_blocks_it_too(self):
        from core import sandbox_changes
        change_id = self.recorded()
        (self.root / "new").mkdir()
        (self.root / "new" / "n.txt").write_text("someone else's\n")
        with self.assertRaises(sandbox_changes.Conflict):
            self.apply(change_id)
        self.assertEqual((self.root / "a.py").read_text(), "print('old')\n")

    def forged(self, path, status="added", root=None):
        """A change set written straight to disk, as if tampered with."""
        import base64
        import json as _json
        from core import sandbox_changes
        os.makedirs(sandbox_changes.CHANGES_DIR, exist_ok=True)
        change_id = uuid.uuid4().hex[:12]
        with open(os.path.join(sandbox_changes.CHANGES_DIR, f"{change_id}.json"), "w", encoding="utf-8") as f:
            _json.dump({"id": change_id, "root": str((root or self.root).resolve()), "session_id": None,
                        "created": time.time(), "changes": [{"path": path, "status": status}], "diff": "",
                        "base_hashes": {}, "applicable": True,
                        "contents": {path: base64.b64encode(b"owned").decode()}}, f)
        return change_id

    def test_paths_outside_the_folder_or_into_protected_places_are_refused(self):
        from core import sandbox_changes
        for path in ("../escaped.txt", ".git/hooks/pre-commit", "data/users.json", ".env", "sub/.env.local",
                     "C:/Windows/x.txt", "/etc/x"):
            with self.assertRaises(sandbox_changes.Conflict, msg=path):
                self.apply(self.forged(path))
        self.assertFalse((self.root.parent / "escaped.txt").exists())
        self.assertEqual(list((self.root / ".git").iterdir()), [], "nothing written into .git")

    def test_an_installed_app_folder_is_refused(self):
        """Found 2026-09-25: an install folder holds the bundled runtime (a
        copy is far over the input limit) and is replaced on update."""
        from core import sandbox_changes
        shutil.rmtree(self.root / ".git")
        with self.assertRaises(sandbox_changes.Conflict) as caught:
            self.apply(self.forged("x.txt"))
        self.assertIn("development checkout", str(caught.exception))
        self.assertFalse((self.root / "x.txt").exists())
        with patch("core.sandbox_changes.available", return_value=False), patch("core.sandbox.run") as never:
            text = call({"command": "ls", "copy_repo": True}, is_admin=True)
        self.assertIn("development checkout", text)
        never.assert_not_called()

    def test_a_git_worktree_counts_as_a_checkout(self):
        """Found 2026-10-05: in a worktree .git is a file, not a folder."""
        from core import sandbox_changes
        shutil.rmtree(self.root / ".git")
        (self.root / ".git").write_text("gitdir: elsewhere\n")
        self.assertTrue(sandbox_changes.available(str(self.root)))
        self.apply(self.forged("x.txt"))
        self.assertTrue((self.root / "x.txt").exists())

    def test_a_change_set_for_another_folder_is_refused(self):
        from core import sandbox_changes
        elsewhere = Path(tempfile.mkdtemp(prefix="jarvis-elsewhere-"))
        self.addCleanup(shutil.rmtree, elsewhere, True)
        with self.assertRaises(sandbox_changes.Conflict):
            self.apply(self.forged("x.txt", root=elsewhere))
        self.assertFalse((elsewhere / "x.txt").exists())

    def test_unapplied_change_sets_expire(self):
        from core import sandbox_changes
        change_id = self.forged("x.txt")
        sandbox_changes.expire(now=time.time() + (sandbox_changes.EXPIRY_DAYS + 1) * 86400)
        with self.assertRaises(KeyError):
            sandbox_changes.get(change_id)

    @unittest.skipUnless(DOCKER_UP, "Docker is not running")
    def test_an_oversized_change_set_can_be_read_but_not_applied(self):
        from core import sandbox_changes
        with patch.object(sandbox, "MAX_CHANGE_BYTES", 4):
            change_id = self.recorded()
        self.assertFalse(sandbox_changes.get(change_id)["applicable"])
        with self.assertRaises(sandbox_changes.Conflict):
            self.apply(change_id)
        self.assertEqual((self.root / "a.py").read_text(), "print('old')\n")

    @unittest.skipUnless(DOCKER_UP, "Docker is not running")
    def test_run_code_keeps_jarvis_edits_for_review_and_no_tool_applies_them(self):
        from core import sandbox_changes
        from core.constants import BASE_DIR
        probe = Path(BASE_DIR) / "sandbox-change-probe.txt"
        self.assertFalse(probe.exists())
        text = call({"command": "echo probe > sandbox-change-probe.txt", "copy_repo": True, "timeout_seconds": 300},
                    is_admin=True)
        self.assertIn("NOT applied", text)
        self.assertFalse(probe.exists(), "the real folder is untouched")
        pending = [c for c in sandbox_changes.list_pending() if c["session_id"] == "sbx-chat"]
        self.assertTrue(pending and pending[0]["changes"] == [{"path": "sandbox-change-probe.txt", "status": "added"}])
        for c in pending:
            sandbox_changes.discard(c["id"])
        names = [s.name for s in tool_registry.specs(tool_registry.OPENAI, True) + tool_registry.specs(tool_registry.CLAUDE, True)]
        self.assertFalse([n for n in names if "apply" in n or "change" in n], names)

    def test_the_review_routes_are_admin_only(self):
        from fastapi.routing import APIRoute
        from core.middleware import require_admin
        from routes import sandbox_routes
        routes = [r for r in sandbox_routes.router.routes if isinstance(r, APIRoute)]
        self.assertEqual(len(routes), 4)
        for route in routes:
            self.assertIn(require_admin, [d.call for d in route.dependant.dependencies], route.path)

    def test_the_apply_route_reports_a_conflict_as_nothing_applied(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routes import sandbox_routes
        app_ = FastAPI()
        app_.include_router(sandbox_routes.router)
        client = TestClient(app_)
        response = client.post(f"/api/sandbox/changes/{self.forged('../escaped.txt')}/apply")
        self.assertEqual(response.status_code, 409)
        self.assertIn("Nothing was applied", response.json()["detail"])
        self.assertEqual(client.post("/api/sandbox/changes/nosuchid/apply").status_code, 404)


def call(args, is_admin=False):
    return asyncio.run(tool_registry.call("run_code", args, tool_registry.ToolContext("sbx-chat", is_admin),
                                          tool_registry.OPENAI))


class RunCodeToolTests(unittest.TestCase):
    """Step 2: the run_code tool every model gets (not Codex, which has its own sandbox)."""

    def test_every_model_is_offered_it_and_claude_runs_it_without_a_prompt(self):
        from core.brain import Brain
        from core.external_brain import ExternalBrain
        self.assertIn("run_code", [t["function"]["name"] for t in ExternalBrain("http://x", "m", None).tools],
                      "a non-admin local model has it")
        self.assertIn("run_code", [s.name for s in tool_registry.specs(tool_registry.CLAUDE)])
        _, allowed, _ = Brain(vault_dir=tempfile.gettempdir())._tool_config()
        self.assertIn("mcp__hive_mind__run_code", allowed, "pre-approved, as a visible revocable grant")

    @unittest.skipUnless(DOCKER_UP, "Docker is not running")
    def test_a_run_reports_output_and_changes_and_writes_nothing_real(self):
        text = call({"command": "python hi.py > out.txt; cat out.txt", "files": '{"hi.py": "print(6 * 7)"}'})
        self.assertIn("exit_code=0", text)
        self.assertIn("42", text)
        self.assertIn("added: out.txt", text)
        self.assertIn("+42", text)

    @unittest.skipUnless(DOCKER_UP, "Docker is not running")
    def test_only_an_admin_gets_the_jarvis_code_and_never_its_data_or_env(self):
        self.assertIn("only an admin chat", call({"command": "ls", "copy_repo": True}))
        text = call({"command": "test -f core/sandbox.py && echo HAVE-CODE; ls -a; test -e data || echo NO-DATA; "
                                "test -e .env || echo NO-ENV", "copy_repo": True, "timeout_seconds": 300}, is_admin=True)
        self.assertIn("HAVE-CODE", text)
        self.assertIn("NO-DATA", text)
        self.assertIn("NO-ENV", text)

    def test_without_docker_it_says_so_and_runs_nothing(self):
        async def down(*args, **kw):
            return 1, "", "error during connect"
        with patch("core.sandbox._docker", side_effect=down):
            text = call({"command": "echo hi"})
        self.assertIn("Not run: the sandbox is unavailable", text)
        self.assertIn("Nothing was run on this computer", text)

    def test_internet_without_docker_says_so_without_asking_first(self):
        from core import permissions

        async def down(*args, **kw):
            return 1, "", "error during connect"
        with patch("core.sandbox._docker", side_effect=down), patch.object(permissions, "decide") as asked:
            text = call({"command": "echo hi", "internet": True})
        self.assertIn("sandbox is unavailable", text)
        asked.assert_not_called()

    def test_bad_input_is_refused_before_anything_runs(self):
        self.assertIn("no command", call({"command": " "}))
        self.assertIn("path -> text", call({"command": "ls", "files": "not json"}))
        self.assertIn("path -> text", call({"command": "ls", "files": {"a": 1}}))


def _host_http_server():
    """A stand-in for JARVIS's API, listening on the host."""
    class Quiet(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b"jarvis")

        def log_message(self, *a):
            pass
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


if __name__ == "__main__":
    if not DOCKER_UP:
        print("WARNING: Docker is not running; the escape tests are skipped and prove nothing.")
    unittest.main(verbosity=2)
