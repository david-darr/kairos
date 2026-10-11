"""Search and resolve explicit composer references against current, visible records."""
import json
import re
import secrets
from pathlib import Path

from fastapi import HTTPException

from core import attachments, artifact_comments, chat_artifacts, chat_files, memory_tools, office_preview
from core.session_manager import session_manager
from core.untrusted import wrap_untrusted
from services import documents_service, skills_service
from services.task_service import task_service

MAX_REFERENCES = 5
MAX_ITEM_CHARS = 8_000
MAX_TOTAL_CHARS = 24_000
TEXT_EXTENSIONS = chat_artifacts.TEXT_EXTENSIONS


def metadata(references: list[dict]) -> list[dict]:
    """Save only the fields needed to reselect a reference on edit/regenerate."""
    saved = [artifact_comments.validate(ref) if ref.get("kind") == "artifact_comment" else
             {"kind": ref["kind"], "id": ref["id"], "session_id": ref.get("session_id"),
             "label": (ref.get("label") if isinstance(ref.get("label"), str) else "Reference")[:500]}
            for ref in references]
    from services.agent_service import agent_service
    for ref in saved:
        if ref["kind"] == "agent":
            agent = agent_service.get(ref["id"])
            if agent:
                ref.update(label=agent["name"], avatar=agent["name"][:1].upper(), color=agent.get("color"))
    return saved


def search(query: str, current_session_id: str | None = None, is_admin: bool = False,
           user: str | None = None, kind: str | None = None) -> list[dict]:
    """Return compact, client-safe search results; no paths outside the vault."""
    query = query.strip()[:100]
    needle = query.casefold()
    results: list[dict] = []
    if is_admin:
        from services.agent_service import agent_service
        for agent in agent_service.list_agents():
            if not needle or needle in (agent['name'] + ' ' + agent.get('role', '')).casefold():
                results.append({"kind": "agent", "id": agent["id"], "label": agent["name"],
                                "detail": agent.get("role", ""), "avatar": agent["name"][:1].upper(),
                                "color": agent.get("color")})
    for skill in skills_service.list_skills():
        if not skill.get("error") and (not needle or needle in (skill["slug"] + " " + skill.get("description", "")).casefold()):
            results.append({"kind": "skill", "id": skill["slug"], "label": skill["slug"], "detail": skill.get("description", "")})
    for tool in _available_tools(current_session_id, is_admin, user):
        if not needle or needle in (tool["name"] + " " + tool["description"]).casefold():
            results.append({"kind": "tool", "id": tool["id"], "label": tool["name"], "detail": tool["description"][:250]})
    for task in task_service.list_tasks():
        if (task.get("schedule_kind") != "card" and task_service.visible_to(task, user, is_admin)
                and (not needle or needle in (task["name"] + " " + task.get("prompt", "")).casefold())):
            results.append({"kind": "automation", "id": task["id"], "label": task["name"], "detail": _schedule(task)})
    docs = documents_service.search_documents(query, max_results=4) if query else documents_service.list_documents()
    for doc in docs:
        results.append({"kind": "document", "id": doc["id"], "label": doc["title"], "detail": "Library document"})
    for group in chat_files.list_library():
        for item in group["files"]:
            if not item["exists"] or (needle and needle not in (item["name"] + " " + group["title"]).casefold()):
                continue
            results.append({"kind": "file", "id": item["id"], "session_id": group["session_id"],
                            "label": item["name"], "detail": group["title"]})
            if sum(r["kind"] == "file" for r in results) >= 4:
                break
        if sum(r["kind"] == "file" for r in results) >= 4:
            break

    if query:
        for hit in memory_tools.search_vault(query, max_results=4):
            path = hit["path"]
            results.append({"kind": "note", "id": path, "label": Path(path).stem, "detail": path})

    headers = session_manager.list_sessions()
    matched = [h for h in headers if h["id"] != current_session_id and
               (not needle or needle in (h.get("title") or "").casefold())]
    if needle and len(matched) < 4:
        ids = {h["id"] for h in matched}
        for hit in memory_tools.search_sessions(query, exclude_session_id=current_session_id, max_results=12):
            if hit["session_id"] not in ids:
                matched.append({"id": hit["session_id"], "title": hit["session_title"]})
                ids.add(hit["session_id"])
    for header in matched[:4]:
        results.append({"kind": "chat", "id": header["id"],
                        "label": header.get("title") or "Untitled chat", "detail": "Conversation"})
    capped, counts = [], {}
    for item in results:
        item_kind = item["kind"]
        if (kind is None or item_kind == kind) and counts.get(item_kind, 0) < 4:
            capped.append(item)
            counts[item_kind] = counts.get(item_kind, 0) + 1
    return capped


def _safe_tool_text(text: str) -> str:
    # Only tool names/descriptions are used. URLs and credential-shaped text
    # in a server-authored description are redacted as well.
    text = re.sub(r"(?i)(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>]+", "[URL omitted]", str(text))
    text = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "[credential omitted]", text)
    text = re.sub(r'''(?i)\b(?:api[_ -]?key|token|password|secret|authorization)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)''',
                  "[credential omitted]", text)
    return re.sub(r"\bsk-[a-zA-Z0-9_-]{12,}", "[credential omitted]", text)


def _available_tools(session_id, is_admin, user) -> list[dict]:
    from core import integrations, model_endpoints, settings, tool_registry
    session = session_manager.get_session(session_id) or {}
    endpoint = model_endpoints.get_endpoint(session.get("model_endpoint_id")) if session.get("model_endpoint_id") else None
    if endpoint is None:
        return []
    surface = {"claude_cli": tool_registry.CLAUDE, "codex_cli": tool_registry.CODEX}.get(endpoint["kind"], tool_registry.OPENAI)
    read_only = (session.get("forge") or {}).get("mode") == "plan"
    disabled = set(settings.get_setting("disabled_tools") or [])
    tools = [{"id": "builtin:" + spec.name, "name": spec.name, "description": spec.description}
             for spec in tool_registry.specs(surface, is_admin, agent=bool(session.get("agent_id")),
                                              read_only=read_only, session_id=session_id or "")
             if spec.name not in disabled and "mcp__hive_mind__" + spec.name not in disabled]
    if surface == tool_registry.CLAUDE:
        for name, description in tool_registry.CLAUDE_NATIVE_TOOLS.items():
            if name in disabled or (name == "Bash" and not is_admin) or (read_only and name not in {"Read", "Glob", "Grep", "WebFetch", "WebSearch"}):
                continue
            tools.append({"id": "native:" + name, "name": name, "description": description})
    # Codex currently exposes only Kairos registry tools, not connected MCPs.
    if surface != tool_registry.CODEX and not read_only:
        tools.extend(tool for tool in integrations.reference_tools(session.get("enabled_integration_ids"), user, is_admin, surface)
                     if tool["name"] not in disabled)
    return [{**tool, "name": _safe_tool_text(tool["name"]), "description": _safe_tool_text(tool["description"])} for tool in tools]


def _schedule(task: dict) -> str:
    kind = task.get("schedule_kind", "once")
    if kind == "daily":
        return f"Daily at {task.get('run_time') or 'unspecified time'} (local time)"
    if kind == "interval":
        return f"Every {task.get('interval_seconds')} seconds"
    return f"Once at {task.get('run_at') or task.get('next_run_at') or 'unspecified time'}"


def _automation_content(task: dict) -> str:
    from core import model_endpoints
    from core.channels import registry as channels
    endpoint = model_endpoints.get_endpoint(task["endpoint_id"]) if task.get("endpoint_id") else None
    channel = next((c for c in channels.list_channels() if c["id"] == task.get("deliver_to_channel")), None)
    runs = task_service.list_runs(task["id"])
    last = runs[0] if runs else {}
    model = (endpoint or {}).get("model") or (endpoint or {}).get("name") or ("Removed model" if task.get("endpoint_id") else "Claude")
    delivery = channel["label"].replace("\u2014", "-") if channel else "Removed delivery target" if task.get("deliver_to_channel") else "No delivery target"
    return (f"Automation: {task['name']}\nEnabled: {bool(task.get('enabled'))}\nSchedule: {_schedule(task)}\n"
            f"Model: {model}\nDelivery: {delivery}\n"
            f"Instructions: {_truncate(task.get('prompt') or '', 3000)}\nLast run outcome: {last.get('outcome') or 'No runs yet'}\n"
            f"Last run output: {_truncate(last.get('output') or '', 3000)}\nLast run error: {_truncate(last.get('error') or '', 1000)}")


def _truncate(content: str, limit: int) -> str:
    marker = "\n[Reference excerpt truncated.]"
    return content if len(content) <= limit else content[:max(0, limit - len(marker))] + marker[:limit]


def _file_content(reference: dict) -> tuple[str, str]:
    session_id, file_id = reference.get("session_id"), reference.get("id")
    if not isinstance(session_id, str) or not isinstance(file_id, str):
        raise ValueError("Invalid file reference")
    item = next((entry for entry in chat_files.list_for_session(session_id) if entry["id"] == file_id), None)
    if item is None or not item["exists"]:
        raise ValueError("A referenced file is no longer available")
    url = item["url"]
    if url.startswith("/chat-files/"):
        path = chat_files.resolve_local(session_id, file_id)
    else:
        path, _ = chat_artifacts.resolve(session_id, url)
    label = "selected chat file"
    provenance = f"File: {item['name']}\nFrom chat: {session_id}\n"
    if path.suffix.lower() in office_preview.PREVIEWABLE and path.stat().st_size <= chat_artifacts.MAX_OFFICE_BYTES:
        try:
            content = json.dumps(office_preview.extract(path, path.suffix.lower()), ensure_ascii=False)
            return label, provenance + content[:MAX_ITEM_CHARS]
        except (office_preview.PreviewUnavailable, OSError, ValueError):
            pass
    if path.suffix.lower() == ".pdf" and attachments.pdfium is not None and path.stat().st_size <= chat_artifacts.MAX_OFFICE_BYTES:
        try:
            pdf = attachments.pdfium.PdfDocument(str(path))
            try:
                pages = []
                for page_index in range(min(len(pdf), 30)):
                    pages.append(pdf[page_index].get_textpage().get_text_range())
                    if sum(map(len, pages)) >= MAX_ITEM_CHARS:
                        break
                content = "\n\n".join(pages)[:MAX_ITEM_CHARS]
                if content.strip():
                    return label, provenance + content
            finally:
                pdf.close()
        except Exception:
            pass
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return label, provenance + f"Path: {path}\nNo text could be extracted. Use an available file tool to inspect it if needed."
    with path.open("rb") as handle:
        data = handle.read(MAX_ITEM_CHARS * 4 + 1)
    content = data.decode("utf-8", errors="replace")[:MAX_ITEM_CHARS]
    if len(data) > MAX_ITEM_CHARS or path.stat().st_size > len(data):
        content += "\n[File excerpt truncated.]"
    return label, provenance + content


def _note_content(reference: dict) -> tuple[str, str]:
    path = reference.get("id")
    if not isinstance(path, str) or len(path) > 500:
        raise ValueError("Invalid note reference")
    relative = Path(path)
    if relative.is_absolute() or relative.suffix.lower() != ".md" or any(part in ("", ".", "..") or part.startswith(".") for part in relative.parts):
        raise ValueError("Invalid note reference")
    try:
        content = memory_tools.read_vault_file(path, max_chars=MAX_ITEM_CHARS)
    except (OSError, ValueError) as error:
        raise ValueError("A referenced note is no longer available") from error
    return "selected vault note", f"Note: {path}\n{content}"


def _chat_content(reference: dict, current_session_id: str) -> tuple[str, str]:
    session_id = reference.get("id")
    if not isinstance(session_id, str) or session_id == current_session_id:
        raise ValueError("Invalid chat reference")
    session = session_manager.get_session(session_id)
    if session is None:
        raise ValueError("A referenced chat is no longer available")
    lines = []
    size = 0
    limit = MAX_ITEM_CHARS - 250  # leave room for the title and truncation note
    truncated = False
    for message in reversed(session.get("messages", [])):
        if message.get("role") not in ("user", "assistant"):
            continue
        line = f"{message['role']}: {message.get('content') or ''}"
        remaining = limit - size
        if len(line) > remaining:
            lines.append(line[-remaining:])
            truncated = True
            break
        lines.append(line)
        size += len(line) + 2
        if size >= limit:
            truncated = True
            break
    content = "\n\n".join(reversed(lines))
    if truncated:
        content = "[Earlier messages omitted.]\n" + content
    return "selected chat", f"Chat: {session.get('title') or session_id}\n{content or '[This chat has no messages.]'}"


def resolve(session_id: str, references: list[dict] | None, is_admin: bool = False, user: str | None = None) -> str:
    """Validate client IDs against current records and build bounded model context."""
    if not references:
        return ""
    if not isinstance(references, list) or any(not isinstance(ref, dict) for ref in references):
        raise ValueError("Invalid references")
    comments = sum(ref.get("kind") == "artifact_comment" for ref in references)
    if comments > artifact_comments.MAX_COMMENTS:
        raise ValueError("Select at most 10 artifact comments")
    if len(references) - comments > MAX_REFERENCES:
        raise ValueError(f"Select at most {MAX_REFERENCES} references")
    parts = []
    seen = set()
    total = len("\n\n[Selected references for this message]\n")
    for reference in references:
        if not isinstance(reference, dict):
            raise ValueError("Invalid reference")
        kind = reference.get("kind")
        if kind == "artifact_comment":
            try:
                parts.append(artifact_comments.resolve(session_id, reference))
            except (HTTPException, OSError, office_preview.PreviewUnavailable) as error:
                raise ValueError("An artifact comment is no longer available") from error
            continue
        if kind not in ("file", "note", "chat", "agent", "skill", "tool", "automation", "document"):
            raise ValueError("Invalid reference type")
        ref_id = reference.get("id")
        source_session = reference.get("session_id")
        if (not isinstance(ref_id, str) or len(ref_id) > 500 or
                (source_session is not None and (not isinstance(source_session, str) or len(source_session) > 100))):
            raise ValueError("Invalid reference")
        key = (kind, source_session, ref_id)
        if key in seen:
            continue
        seen.add(key)
        if kind == "agent":
            from services.agent_service import agent_service
            if not is_admin:
                raise ValueError("Only admins can hand work to agents")
            if agent_service.get(ref_id) is None:
                raise ValueError("A referenced agent is no longer available")
            continue
        instruction = ""
        try:
            if kind == "file":
                label, content = _file_content(reference)
            elif kind == "note":
                label, content = _note_content(reference)
            elif kind == "chat":
                label, content = _chat_content(reference, session_id)
            elif kind == "skill":
                try:
                    skill = skills_service.get_skill(ref_id)
                except ValueError as error:
                    raise ValueError("A referenced skill is no longer available") from error
                if skill is None:
                    raise ValueError("A referenced skill is no longer available")
                label, content = "selected skill", f"Skill: {skill['slug']}\n{skill['body']}"
                instruction = "Follow this skill for this message\n"
                reference["label"] = skill["slug"]
            elif kind == "tool":
                tool = next((t for t in _available_tools(session_id, is_admin, user) if t["id"] == ref_id), None)
                if tool is None:
                    raise ValueError("A referenced tool is no longer available")
                label, content = "selected tool", f"Tool: {tool['name']}\nDescription: {tool['description']}"
                instruction = f"Use the {tool['name']} tool for this message if it applies\n"
                reference["label"] = tool["name"]
            elif kind == "automation":
                task = task_service.get_task(ref_id)
                if task is None or task.get("schedule_kind") == "card" or not task_service.visible_to(task, user, is_admin):
                    raise ValueError("A referenced automation is no longer available")
                label, content = "selected automation", _automation_content(task)
                instruction = "Reference only. Do not run or change this automation.\n"
                reference["label"] = task["name"]
            elif kind == "document":
                doc = documents_service.get_document(ref_id)
                if doc is None:
                    raise ValueError("A referenced document is no longer available")
                label, content = "selected Library document", f"Document: {doc['title']}\n{doc['content']}"
                reference["label"] = doc["title"]
        except (HTTPException, OSError) as error:
            raise ValueError("A reference is no longer available") from error
        remaining = MAX_TOTAL_CHARS - total
        if remaining <= 300:
            continue
        if kind == "skill":
            # An explicitly selected skill is an instruction, unlike reference
            # documents. Do not fence it with the contradictory data-only policy.
            nonce = secrets.token_hex(4)
            prefix, suffix = f"<<<SELECTED-SKILL-{nonce}>>>\n", f"\n<<<END-SKILL-{nonce}>>>"
            overhead = len(instruction + prefix + suffix) + 2
            wrapped = instruction + prefix + _truncate(content, min(MAX_ITEM_CHARS, remaining - overhead)) + suffix
        else:
            overhead = len(instruction + wrap_untrusted(label, "")) + 2
            if remaining <= overhead:
                continue
            wrapped = instruction + wrap_untrusted(label, _truncate(content, min(MAX_ITEM_CHARS, remaining - overhead)))
        parts.append(wrapped)
        total += len(wrapped) + 2
    if comments:
        parts.append(artifact_comments.PUBLISH_INSTRUCTION)
    return "\n\n[Selected references for this message]\n" + "\n\n".join(parts) if parts else ""
