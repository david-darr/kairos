"""Library tab: a real document store, deliberately scoped far lighter than
Odysseus's own documents/RAG system (specs/documents-rag-uploads.md — Chroma
vector DB, embeddings, PDF/Office extraction, versioned "living documents").
That's too heavy relative to where JARVIS is; this is the honest v1 slice:
create/read/update/delete plain markdown/text documents, plus a bounded
keyword search over their content — same search shape as core/memory_tools.py
uses for the vault/session hive-mind, not a second search paradigm.

Content is file-backed per document (matches skills_service.py's convention
for anything whose body can be arbitrarily long), with a small JSON index
holding cheap-to-list metadata (title/tags/timestamps) so listing the
library never has to read every document's full body off disk.
"""
import os
import time
import uuid
from typing import Optional

from core import accounts
from core.atomic_io import read_json, write_json_atomic

# Each account's own documents/ and documents_index.json (Multi-Account phase 2); a test may point these
# at its own folder and file.
DOCUMENTS_DIR = None
DOCUMENTS_INDEX_FILE = None


def documents_dir() -> str:
    return DOCUMENTS_DIR or accounts.path("documents")


def index_file() -> str:
    return DOCUMENTS_INDEX_FILE or accounts.path("documents_index.json")

SNIPPET_RADIUS = 200  # matches core/memory_tools.py's token-efficiency convention


def _content_path(doc_id: str) -> str:
    return os.path.join(documents_dir(), f"{doc_id}.md")


def _load_index() -> dict:
    return read_json(index_file(), {})


def _save_index(index: dict) -> None:
    write_json_atomic(index_file(), index)


def list_documents() -> list[dict]:
    index = _load_index()
    items = list(index.values())
    return sorted(items, key=lambda d: -d["updated_at"])


def get_document(doc_id: str) -> Optional[dict]:
    index = _load_index()
    meta = index.get(doc_id)
    if meta is None:
        return None
    path = _content_path(doc_id)
    content = ""
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8", newline="") as f:
            content = f.read()
    return {**meta, "content": content}


def create_document(title: str, content: str = "", tags: Optional[list[str]] = None) -> dict:
    doc_id = uuid.uuid4().hex[:12]
    now = time.time()
    os.makedirs(documents_dir(), exist_ok=True)
    with open(_content_path(doc_id), "w", encoding="utf-8", newline="") as f:
        f.write(content)
    meta = {"id": doc_id, "title": title, "tags": tags or [], "created_at": now, "updated_at": now}
    index = _load_index()
    index[doc_id] = meta
    _save_index(index)
    return {**meta, "content": content}


def update_document(doc_id: str, title: Optional[str] = None, content: Optional[str] = None,
                     tags: Optional[list[str]] = None) -> dict:
    index = _load_index()
    meta = index.get(doc_id)
    if meta is None:
        raise KeyError(f"no such document: {doc_id}")
    if content is None:
        # Read the body before touching the index, so a missing or unreadable
        # body file cannot leave a half-saved update behind.
        content = ""
        if os.path.exists(_content_path(doc_id)):
            with open(_content_path(doc_id), "r", encoding="utf-8", newline="") as f:
                content = f.read()
    else:
        os.makedirs(documents_dir(), exist_ok=True)
        with open(_content_path(doc_id), "w", encoding="utf-8", newline="") as f:
            f.write(content)
    if title is not None:
        meta["title"] = title
    if tags is not None:
        meta["tags"] = tags
    meta["updated_at"] = time.time()
    index[doc_id] = meta
    _save_index(index)
    return {**meta, "content": content}


def delete_document(doc_id: str) -> None:
    index = _load_index()
    if doc_id not in index:
        return
    del index[doc_id]
    _save_index(index)
    path = _content_path(doc_id)
    if os.path.exists(path):
        os.remove(path)


def import_document(filename: str, raw_content: str) -> dict:
    """Library tab's "Import" (Electron file picker → main.js's
    pick-document-file, same pattern as Brain's skill import) — always
    creates a new document rather than upserting by name, since two
    documents can legitimately share a title (unlike Skills' unique-slug
    model), so silent overwrite would be the wrong default here."""
    title = os.path.splitext(os.path.basename(filename))[0]
    return create_document(title, raw_content)


def search_documents(query: str, max_results: int = 5) -> list[dict]:
    """Bounded keyword search over every document's content — same shape as
    core/memory_tools.py's search_vault/search_sessions (short snippet,
    capped results), not a vector/embedding search. Title matches count too,
    surfaced with an empty snippet since there's no surrounding text to
    show."""
    query_lower = query.lower()
    results: list[dict] = []
    for meta in list_documents():
        if len(results) >= max_results:
            break
        if query_lower in meta["title"].lower():
            results.append({"id": meta["id"], "title": meta["title"], "snippet": ""})
            continue
        path = _content_path(meta["id"])
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8", newline="") as f:
            content = f.read()
        idx = content.lower().find(query_lower)
        if idx == -1:
            continue
        start = max(0, idx - SNIPPET_RADIUS)
        end = min(len(content), idx + len(query) + SNIPPET_RADIUS)
        snippet = ("…" if start > 0 else "") + content[start:end].strip() + ("…" if end < len(content) else "")
        results.append({"id": meta["id"], "title": meta["title"], "snippet": snippet})
    return results
