"""The connected-app catalogue: categories, native apps and what a tool does (Phase 2, unit U5).

Two jobs, both pure and import-light so U4's grant catalogue and the UI model can lean on them.

1. Categories and descriptions for the apps a person can connect: the MCP servers Kairos knows
   (core/mcp_catalog.json), the native accounts (Google, email, calendars) and the cards that have
   their own setup (HighLevel, X research, Whop).
2. `effect_of(tool_name, read_only)`: whether a tool reads, writes or is unknown. A read-only app
   scope permits only "read"; an unknown effect is refused there. A server's own read-only claim
   wins over the name, and a name that mixes a read and a write word counts as a write.
"""
import re
from typing import Optional

CATEGORIES = ["Productivity", "Communication", "Developer", "Data", "Finance", "Design", "Search", "Other"]

# Known MCP catalogue ids by category; anything not listed is "Other".
_BY_CATEGORY = {
    "Productivity": "airtable asana atlassian attio calendly clickup close craft dropbox fireflies linear monday notion todoist gamma miro",
    "Communication": "intercom klaviyo twilio-docs",
    "Developer": "aws-knowledge betterstack buildkite circleci cloudflare context7 datadog deepwiki gitlab grafana hugging_face n8n-official neon "
                 "netlify postman prisma-postgres railway semgrep sentry supabase unreal-engine vercel webflow wordpress-com globalping microsoft-learn",
    "Data": "algolia amplitude mixpanel motherduck twelve-data wolfram",
    "Finance": "paypal plaid robinhood square stripe",
    "Design": "canva cloudinary comfy-cloud figma",
    "Search": "alltrails indeed kiwi strava trivago",
}
CATEGORY_OF = {app: category for category, ids in _BY_CATEGORY.items() for app in ids.split()}

# Apps with their own setup, shown as cards beside the MCP catalogue.
NATIVE_APPS = [
    {"id": "google", "label": "Google Workspace", "category": "Productivity", "kind": "native", "multi_account": True,
     "description": "Gmail, Calendar and Drive on your Google accounts."},
    {"id": "email", "label": "Email (IMAP and SMTP)", "category": "Communication", "kind": "native", "multi_account": True,
     "description": "Mailboxes set up in the Email tab. Bots can read and draft; sending follows each bot's approval level."},
    {"id": "highlevel", "label": "HighLevel", "category": "Productivity", "kind": "card", "multi_account": False,
     "description": "Contacts, notes, tasks, appointments and opportunities in your HighLevel account. Bots never send messages, "
                    "run campaigns or workflows, or touch payments."},
    {"id": "x", "label": "X research", "category": "Search", "kind": "card", "multi_account": False,
     "description": "Search recent posts, read a profile or a post, and count a topic. Read-only, with your own X key."},
    {"id": "whop", "label": "Whop", "category": "Finance", "kind": "card", "multi_account": False,
     "description": "Your Whop store through its MCP server. Added switched off; review it, then turn it on.",
     "mcp": {"name": "whop", "url": "https://mcp.whop.com/mcp", "mcp_type": "http"}},
]

READ_WORDS = {"get", "list", "search", "read", "fetch", "find", "query", "describe", "show", "lookup", "look", "check", "count",
              "view", "browse", "inspect", "preview", "retrieve", "download", "summarize", "summarise", "explain", "analyze",
              "analyse", "export", "history", "status", "info", "whoami", "ping", "head", "select", "resolve", "validate",
              "verify", "compare", "diff", "tail", "watch"}
WRITE_WORDS = {"create", "update", "delete", "remove", "send", "post", "write", "add", "set", "put", "patch", "edit", "move",
               "rename", "reply", "forward", "publish", "upload", "insert", "modify", "archive", "cancel", "approve", "reject",
               "merge", "push", "commit", "deploy", "run", "execute", "start", "stop", "restart", "trigger", "invite", "share",
               "grant", "revoke", "transfer", "pay", "charge", "refund", "book", "schedule", "assign", "close", "open", "save",
               "submit", "apply", "import", "drop", "truncate", "reset", "clear", "enable", "disable", "install", "uninstall",
               "label", "tag", "pin", "unpin", "mark", "follow", "unfollow", "like", "react", "comment", "draft", "attach",
               "detach", "sync", "invoke", "call", "exec", "kill", "restore", "rollback", "revert", "provision", "configure"}


def _words(name: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(name))
    return [w for w in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if w]


def effect_of(tool_name: str, read_only: Optional[bool] = None) -> str:
    """"read", "write" or "unknown". `read_only` is the server's own claim (annotations.readOnlyHint) when it made one."""
    if read_only is True:
        return "read"
    if read_only is False:
        return "write"
    words = _words(tool_name)
    if any(w in WRITE_WORDS for w in words):
        return "write"  # a name that mixes a read word and a write word is treated as a write: the safe direction
    return "read" if any(w in READ_WORDS for w in words) else "unknown"


def category_for(catalog_id: str = "", name: str = "") -> str:
    return CATEGORY_OF.get(catalog_id) or CATEGORY_OF.get((name or "").lower().replace(" ", "-")) or "Other"


def describe_native(app_id: str) -> Optional[dict]:
    return next((dict(a) for a in NATIVE_APPS if a["id"] == app_id), None)
