"""The slash commands, in one table for /help and completion.

They mirror the app (static/js/slashCommands.js) where the action makes sense
in a terminal; app-only ones say so and bring the app window forward.
"""

COMMANDS = [
    ("help", "", "List commands and keys"),
    ("new", "", "Start a new chat in this folder"),
    ("resume", "[id or title]", "Open an earlier chat"),
    ("rename", "<title>", "Rename this chat"),
    ("model", "[name [effort]]", "Choose this chat's model: sonnet 5.5, sol 6.1 high, ..."),
    ("effort", "[level]", "Reasoning effort for this chat's model"),
    ("mode", "[base|auto|build|plan]", "Permission mode, or Build and Plan in Forge"),
    ("compact", "", "Summarise the chat to free context"),
    ("rewind", "", "Remove the last exchange"),
    ("fork", "", "Copy this chat into a new one"),
    ("stop", "", "Stop the reply that is running"),
    ("forge", "<task> [--worktree]", "Start a Forge session in this folder"),
    ("diff", "", "Show this Forge session's changes"),
    ("undo", "", "Undo the last Forge turn's file changes"),
    ("revert", "<file>", "Put one file back as it was"),
    ("agents", "[reply|dismiss <n> [text]]", "Agents and their inbox"),
    ("permissions", "", "Standing grants and this chat's mode"),
    ("models", "", "Model connections, usage and what this computer reports"),
    ("usage", "", "This chat's tokens per hour today, stream rate and context"),
    ("copy", "", "Copy the last reply to the clipboard"),
    ("tools", "", "Show the last reply's tool steps in full"),
    ("clear", "", "Clear this tab's view (the chat stays)"),
    ("quit", "", "Leave (the chat stays in Kairos)"),
]
APP_ONLY = {
    "capture": "Screen capture", "computer": "Computer use", "store": "The Tool Store",
    "settings": "Settings", "vault": "The vault", "memory": "Memory", "skills": "Skills",
    "workspace": "Workspaces", "demo": "The demo", "setup": "Setup", "shortcuts": "Shortcuts",
    "find": "Find", "terminal": "The terminal panel", "star": "Starring",
    "delete": "Deleting chats",
}
NAMES = [name for name, _, _ in COMMANDS] + ["exit"]


def parse(line: str) -> tuple[str, str] | None:
    if not line.startswith("/") or line.startswith("//"):
        return None
    name, _, rest = line[1:].partition(" ")
    return name.strip().lower(), rest.strip()
