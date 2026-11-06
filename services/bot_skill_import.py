"""Bounded skill import: from a source link, pasted text, or this computer's other AI tools.

Nothing here runs imported files. Each skill keeps only its SKILL.md; every other file is
listed as skipped. Every imported skill lands disabled, with the scan's warnings, and
needs a full-text review before it can be switched on.

Limits for one source import: 30 skills, 128 requests, 8 MiB, 60 seconds, 256 KiB per file.
Hosts are fixed: github.com links resolve through api.github.com and raw.githubusercontent.com.
"""
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

from core import cli_env
from services import bot_skill_library, bot_skills
from services.bot_skills import MAX_SKILL, SkillError

MAX_SKILLS, MAX_REQUESTS, MAX_BYTES, MAX_SECONDS = 30, 128, 8 * 1024 * 1024, 60
API_HOST, RAW_HOST = "api.github.com", "raw.githubusercontent.com"
SEGMENT = re.compile(r"[A-Za-z0-9_.-]+\Z")


# -- the budget every fetch is charged to -------------------------------------------------------

class Budget:
    def __init__(self, requests=MAX_REQUESTS, size=MAX_BYTES, seconds=MAX_SECONDS, clock=time.monotonic):
        self.requests, self.size, self.deadline, self.clock = requests, size, clock() + seconds, clock
        self.used_requests = self.used_bytes = 0

    def charge(self, count=0):
        if self.clock() > self.deadline:
            raise SkillError("The import took longer than 60 seconds and was stopped.", 413)
        if count == 0:
            self.used_requests += 1
            if self.used_requests > self.requests:
                raise SkillError("The import needed more than 128 requests and was stopped.", 413)
        self.used_bytes += count
        if self.used_bytes > self.size:
            raise SkillError("The import is larger than 8 MiB and was stopped.", 413)


def http_fetch(url, limit):
    """GET one allowed https URL with no redirects, never reading past `limit` bytes."""
    import httpx
    host = urlparse(url).hostname
    if urlparse(url).scheme != "https" or host not in {API_HOST, RAW_HOST}:
        raise SkillError("That host is not allowed for skill imports.", 403)
    try:
        with httpx.Client(timeout=15, follow_redirects=False, trust_env=False,
                          headers={"Accept": "application/vnd.github+json", "User-Agent": "kairos-skill-import"}) as client:
            with client.stream("GET", url) as response:
                if response.status_code != 200:
                    raise SkillError(f"The source answered with status {response.status_code}.", 400)
                data = b""
                for part in response.iter_bytes():
                    data += part
                    if len(data) > limit:
                        raise SkillError("A file in this source is too large to import.", 413)
                return data
    except httpx.HTTPError as error:
        raise SkillError(f"Could not reach the source: {error}", 400) from error


# -- reading the source text --------------------------------------------------------------------

def parse_source(source):
    """Return {owner, repo, ref, path, only} for a GitHub link, `owner/repo`, or a skills.sh page."""
    if not isinstance(source, str) or not source.strip() or len(source) > 2048:
        raise SkillError("Enter a GitHub link, owner/repo, or a skills.sh link.")
    text = source.strip()
    if "://" not in text:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", text):
            raise SkillError("Enter a GitHub link, owner/repo, or a skills.sh link.")
        owner, repo = text.split("/")
        return {"owner": owner, "repo": repo.removesuffix(".git"), "ref": None, "path": "", "only": None}
    parsed = urlparse(text)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SkillError("Use a plain https link without a query or login.")
    parts = [unquote(p) for p in parsed.path.split("/") if p]
    if any(not SEGMENT.fullmatch(p) or p in {".", ".."} for p in parts) or len(parts) > 32:
        raise SkillError("That link has an invalid path.")
    if host in {"skills.sh", "www.skills.sh"}:
        if len(parts) < 2:
            raise SkillError("Use a skills.sh link that names an owner and a repository.")
        return {"owner": parts[0], "repo": parts[1], "ref": None, "path": "", "only": parts[2] if len(parts) > 2 else None}
    if host == "github.com":
        if len(parts) < 2:
            raise SkillError("Use a GitHub link that names an owner and a repository.")
        owner, repo, rest = parts[0], parts[1].removesuffix(".git"), parts[2:]
        if not rest:
            return {"owner": owner, "repo": repo, "ref": None, "path": "", "only": None}
        if rest[0] not in {"tree", "blob"} or len(rest) < 2:
            raise SkillError("Use a repository, folder or file link.")
        return {"owner": owner, "repo": repo, "ref": rest[1], "path": "/".join(rest[2:]), "only": None}
    if host == RAW_HOST:
        if len(parts) < 4:
            raise SkillError("Use a raw link that ends in a file.")
        return {"owner": parts[0], "repo": parts[1], "ref": parts[2], "path": "/".join(parts[3:]), "only": None}
    raise SkillError("Skills can be imported from GitHub or skills.sh links.")


def folder_name(path, repo):
    parent = path.rsplit("/", 1)[0] if "/" in path else ""
    return parent.rsplit("/", 1)[-1] if parent else repo


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:64]


# -- fetching candidates ------------------------------------------------------------------------

def gather(source, *, fetch=None, budget=None):
    """List the skills a source holds. `fetch(url, limit) -> bytes` is replaceable for tests."""
    spec = parse_source(source)
    budget = budget or Budget()
    base = fetch or http_fetch

    def get(url, limit):
        budget.charge()
        data = base(url, limit)
        budget.charge(len(data))
        return data

    owner, repo = spec["owner"], spec["repo"]
    raw = lambda ref, path: f"https://{RAW_HOST}/{owner}/{repo}/{ref}/{path}"
    skipped, found = [], []
    path = spec["path"]
    if path.endswith("SKILL.md") or (path and spec["ref"] and path.rsplit("/", 1)[-1].lower().endswith(".md")):
        if not path.endswith("SKILL.md"):
            raise SkillError("The link must point to a SKILL.md file or a folder.")
        found.append({"path": path, "ref": spec["ref"], "others": []})
    else:
        ref = spec["ref"]
        if ref is None:
            info = json.loads(get(f"https://{API_HOST}/repos/{owner}/{repo}", 256 * 1024))
            ref = info.get("default_branch")
            if not isinstance(ref, str) or not SEGMENT.fullmatch(ref):
                raise SkillError("The repository has no usable default branch.")
        tree = json.loads(get(f"https://{API_HOST}/repos/{owner}/{repo}/git/trees/{ref}?recursive=1", 4 * 1024 * 1024))
        files = [row for row in tree.get("tree", []) if row.get("type") == "blob" and isinstance(row.get("path"), str)]
        prefix = path.rstrip("/") + "/" if path else ""
        files = [row for row in files if row["path"].startswith(prefix)]
        for row in sorted(files, key=lambda r: r["path"]):
            if row["path"].rsplit("/", 1)[-1] != "SKILL.md":
                continue
            if "node_modules" in row["path"].split("/") or any(p.startswith(".") for p in row["path"].split("/")):
                skipped.append({"path": row["path"], "reason": "hidden or package folder"})
                continue
            found.append({"path": row["path"], "ref": ref, "others": []})
        folders = [i["path"].rsplit("/", 1)[0] + "/" if "/" in i["path"] else "" for i in found]
        for item, folder in zip(found, folders):
            nested = [f for f in folders if f != folder and f.startswith(folder)]
            item["others"] = [row["path"][len(folder):] for row in files if row["path"].startswith(folder)
                              and row["path"] != item["path"] and not any(row["path"].startswith(n) for n in nested)][:200]
        if spec["only"]:
            found = [i for i in found if folder_name(i["path"], repo) == spec["only"]]
            if not found:
                raise SkillError(f"The repository has no skill named {spec['only']}.", 404)
    if len(found) > MAX_SKILLS:
        skipped += [{"path": i["path"], "reason": "over the 30 skill limit"} for i in found[MAX_SKILLS:]]
        found = found[:MAX_SKILLS]
    candidates = []
    for item in found:
        try:
            text = get(raw(item["ref"], item["path"]), MAX_SKILL).decode("utf-8-sig").replace("\r\n", "\n")
        except UnicodeDecodeError:
            skipped.append({"path": item["path"], "reason": "not UTF-8 text"})
            continue
        label = folder_name(item["path"], repo)
        declared = re.search(r"(?m)^name:\s*[\"']?([a-z0-9-]+)[\"']?\s*$", text.split("\n---", 1)[0]) if text.startswith("---\n") else None
        candidates.append({"name": declared.group(1) if declared and len(declared.group(1)) <= 64 else slug(label), "skill_md": text,
                           "source": f"github:{owner}/{repo}@{item['ref']}/{item['path']}", "skipped_files": item["others"]})
    return {"candidates": candidates, "skipped": skipped, "requests": budget.used_requests, "bytes": budget.used_bytes}


# -- turning candidates into disabled skills -----------------------------------------------------

def _land(candidates, install):
    results = []
    for item in candidates:
        try:
            view = install(item)
            results.append({"name": item["name"], "status": "imported", "warnings": view["warnings"],
                            "skipped_files": item["skipped_files"]})
        except SkillError as error:
            exists = error.status == 409
            results.append({"name": item["name"], "status": "exists" if exists else "refused",
                            "reason": "A skill with this name is already here." if exists else str(error)})
    return results


def import_source(bot_id, source, *, fetch=None, budget=None):
    """Import into one bot's private skills, disabled. Existing names are never overwritten."""
    found = gather(source, fetch=fetch, budget=budget)
    results = _land(found["candidates"], lambda c: bot_skills.install(
        bot_id, c["name"], c["skill_md"], source=c["source"], skipped_files=c["skipped_files"]))
    return {"results": results, "skipped": found["skipped"], "requests": found["requests"], "bytes": found["bytes"]}


def import_source_to_library(source, *, fetch=None, budget=None):
    found = gather(source, fetch=fetch, budget=budget)
    results = _land(found["candidates"], lambda c: bot_skill_library.publish(
        c["name"], c["skill_md"], source=c["source"], origin="imported", skipped_files=c["skipped_files"]))
    return {"results": results, "skipped": found["skipped"], "requests": found["requests"], "bytes": found["bytes"]}


def candidate_from_text(content, filename=None):
    """One pasted or uploaded SKILL.md."""
    if not isinstance(content, str) or not content.strip():
        raise SkillError("Paste the text of a SKILL.md file.")
    if len(content.encode("utf-8")) > MAX_SKILL:
        raise SkillError("SKILL.md exceeds 256 KiB.", 413)
    text = content.replace("\r\n", "\n").lstrip("﻿")
    declared = re.search(r"(?m)^name:\s*[\"']?([A-Za-z0-9-]+)[\"']?\s*$", text.split("\n---", 1)[0]) if text.startswith("---\n") else None
    label = declared.group(1) if declared else Path(filename or "").stem if filename and Path(filename).stem.upper() != "SKILL" else ""
    skill_name = slug(label)
    if not skill_name:
        raise SkillError("Add a name line to the SKILL.md frontmatter, or upload a file named after the skill.")
    return {"name": skill_name, "skill_md": text, "source": "pasted", "skipped_files": []}


def import_text(bot_id, content, filename=None):
    c = candidate_from_text(content, filename)
    return {"results": _land([c], lambda i: bot_skills.install(bot_id, i["name"], i["skill_md"], source=i["source"])),
            "skipped": []}


def import_text_to_library(content, filename=None):
    c = candidate_from_text(content, filename)
    return {"results": _land([c], lambda i: bot_skill_library.publish(i["name"], i["skill_md"], source=i["source"], origin="imported")),
            "skipped": []}


# -- skills from this computer's other AI tools (setup import) -------------------------------------

SETUP_FILE_LIMIT, SETUP_SKILL_LIMIT, SETUP_FILES, SETUP_TOTAL, SETUP_DEPTH = 512 * 1024, 4 * 1024 * 1024, 200, 48 * 1024 * 1024, 6
CREDENTIAL_NAME = re.compile(r"(?i)(^\.env|\.pem\Z|\.key\Z|\.p12\Z|\.pfx\Z|id_rsa|id_ed25519|credential|secret|token|password|\.npmrc\Z|\.netrc\Z)")


def _linked(path):
    return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def _skip_reason(path, relative):
    if _linked(path):
        return "a link"
    if len(relative.parts) > SETUP_DEPTH:
        return "too deep"
    if CREDENTIAL_NAME.search(path.name):
        return "a credential file"
    if any(p.startswith(".") or p == "node_modules" for p in relative.parts):
        return "a hidden or package folder"
    return "too large" if path.stat().st_size > SETUP_FILE_LIMIT else ""


def _read_setup_skill(tool, folder, home):
    """One folder's preview row, or None when it holds no SKILL.md of its own."""
    skill_file = folder / "SKILL.md"
    if _linked(skill_file) or not skill_file.is_file() or not skill_file.resolve().is_relative_to(home):
        return None
    entry = {"tool": tool, "folder": folder.name, "name": slug(folder.name), "path": str(folder), "skipped_files": [],
             "status": "ready", "reason": "", "warnings": []}
    if skill_file.stat().st_size > min(SETUP_FILE_LIMIT, MAX_SKILL):
        return {**entry, "status": "skipped", "reason": "SKILL.md is too large"}
    try:
        text = skill_file.read_text(encoding="utf-8")
        bot_skills.usable_name(entry["name"])
        entry["warnings"] = bot_skills.scan(bot_skills.bundle(entry["name"], text))
    except (OSError, UnicodeError):
        return {**entry, "status": "skipped", "reason": "This skill could not be read."}
    except SkillError as error:
        # A skill the scanner refuses is shown, never imported.
        return {**entry, "status": "refused", "reason": str(error)}
    for index, path in enumerate(sorted(p for p in folder.rglob("*") if p != skill_file and (p.is_file() or _linked(p)))):
        if index >= SETUP_FILES:
            entry["reason"] = "Only the first 200 other files are listed."
            break
        entry["skipped_files"].append(path.relative_to(folder).as_posix() + " (" + (_skip_reason(path, path.relative_to(folder)) or "not imported") + ")")
    return entry


def scan_setup_skills(home=None, *, seconds=2, clock=time.monotonic, locations=None):
    """Preview the skills other AI tools left on this computer. Reads only; copies nothing.

    A skill the scanner flags is listed with its warnings and comes in switched off, like every import."""
    home = Path(home or cli_env.import_root() or Path.home()).resolve()
    deadline, total, limited, found = clock() + seconds, 0, False, []
    codex = Path(os.environ.get("CODEX_HOME") or home / ".codex")
    defaults = [("Claude Code", home / ".claude" / "skills"), ("Codex", codex / "skills")]
    own = cli_env.import_root()
    if own and home == Path(own).resolve():  # an account with its own sign-ins reads only its own folders
        defaults = [("Claude Code", Path(cli_env.claude_dir()) / "skills"), ("Codex", Path(cli_env.codex_dir()) / "skills")]
    for tool, root in locations or defaults:
        if not root.is_dir() or _linked(root):
            continue
        for folder in sorted(p for p in root.iterdir() if p.is_dir()):
            if clock() > deadline or total > SETUP_TOTAL:
                limited = True
                break
            if folder.name.startswith(".") or folder.name == "node_modules" or _linked(folder):
                continue
            entry = _read_setup_skill(tool, folder, home)
            if entry:
                total += (folder / "SKILL.md").stat().st_size
                found.append(entry)
    return {"skills": found, "limited": limited}


def apply_setup_skills(bot_id, selections, *, home=None):
    """Import the chosen folders (by folder name and tool) as disabled skills. Re-scans first."""
    wanted = {(s.get("tool"), s.get("folder")) for s in selections} if isinstance(selections, list) else set()
    if not wanted or len(wanted) > MAX_SKILLS:
        raise SkillError("Choose between 1 and 30 skills to import.")
    scan = scan_setup_skills(home, seconds=10)
    candidates = []
    for item in scan["skills"]:
        if (item["tool"], item["folder"]) not in wanted or item["status"] != "ready":
            continue
        text = (Path(item["path"]) / "SKILL.md").read_text(encoding="utf-8")
        candidates.append({"name": item["name"], "skill_md": text, "source": f"setup:{item['tool']}/{item['folder']}",
                           "skipped_files": item["skipped_files"]})
    target = (lambda c: bot_skills.install(bot_id, c["name"], c["skill_md"], source=c["source"], skipped_files=c["skipped_files"])) \
        if bot_id else (lambda c: bot_skill_library.publish(c["name"], c["skill_md"], source=c["source"], origin="imported",
                                                           skipped_files=c["skipped_files"]))
    return {"results": _land(candidates, target)}
