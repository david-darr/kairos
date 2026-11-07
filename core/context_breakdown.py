"""What fills a chat's context window, by part (Session Usage and Model Tracking, unit 5, 2026-11-07; after
Hermes's agent/context_breakdown.py and its mobile Session Details).

For a local or API chat, Kairos holds the whole request it sends (core/external_brain.py): the system message,
the tool definitions and the conversation, tool rounds included. Each part is measured in characters from that
live brain, then the provider's measured prompt size is shared out in the same proportions, so the parts always
add up to the measured total. The split is an estimate (characters are not tokens), and says so; the total is
the provider's.

- System prompt: the system message (Kairos's instructions, the project's or bot's, the computer note).
- Tool definitions: the tool list sent with every request.
- Memory and skills: what memory, vault, past-chat and skill tools returned into the conversation.
- Conversation: everything else said, tool calls and their other results included.

Claude Code, Codex and Antigravity build their own requests, so their chats show the measured total only.
"""
import json
from typing import Optional

PARTS = (("system", "System prompt"), ("tools", "Tool definitions"), ("memory", "Memory and skills"),
         ("conversation", "Conversation"))
# Tools whose results are memory or skills brought into the conversation (core/memory_tools.py and friends).
MEMORY_TOOLS = ("read_skill", "search_skills", "list_skills", "search_vault", "read_vault_file", "search_sessions",
                "list_notes", "list_documents", "read_document", "list_specs", "read_spec", "list_contacts",
                "memory_search", "memory_read", "recall")


def _size(value) -> int:
    if value is None:
        return 0
    return len(value) if isinstance(value, str) else len(json.dumps(value, ensure_ascii=False))


def is_memory_tool(name: Optional[str]) -> bool:
    return bool(name) and (name in MEMORY_TOOLS or name.startswith("memory_") or name.startswith("bot_memory"))


def measure(messages: list[dict], tools: Optional[list]) -> dict:
    """Characters per part for one request's messages and tool list."""
    sizes = {key: 0 for key, _ in PARTS}
    sizes["tools"] = _size(tools or [])
    names = {}
    for message in messages:
        for call in message.get("tool_calls") or []:
            if isinstance(call, dict):
                names[call.get("id")] = (call.get("function") or {}).get("name")
    for index, message in enumerate(messages):
        role = message.get("role")
        size = _size(message.get("content")) + _size(message.get("tool_calls"))
        if role == "system" and index == 0:
            sizes["system"] += size
        elif role == "tool" and is_memory_tool(names.get(message.get("tool_call_id"))):
            sizes["memory"] += size
        else:
            sizes["conversation"] += size
    return sizes


def scale(sizes: dict, used_tokens: int) -> list[dict]:
    """The measured total shared out by the parts' sizes; the parts sum exactly to `used_tokens`."""
    total = sum(sizes.values())
    if not total or not used_tokens:
        return []
    parts, given = [], 0
    for key, label in PARTS:
        tokens = round(used_tokens * sizes.get(key, 0) / total)
        parts.append({"key": key, "label": label, "tokens": tokens, "estimated": True})
        given += tokens
    # Rounding goes to the conversation, so the sum is the provider's number.
    parts[-1]["tokens"] = max(0, parts[-1]["tokens"] + used_tokens - given)
    return parts


def for_brain(brain, used_tokens: Optional[int]) -> Optional[list[dict]]:
    """The parts for a live local/API brain's last request, or None for any other brain."""
    messages = getattr(brain, "_messages", None)
    if not isinstance(messages, list) or not isinstance(used_tokens, int):
        return None
    return scale(measure(messages, getattr(brain, "tools", None)), used_tokens) or None
