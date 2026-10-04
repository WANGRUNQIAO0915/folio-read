"""On-demand local search across paper text, annotations and conversations."""
from __future__ import annotations

from .store import Workspace


def _entries(ws: Workspace, paper: dict, organization=None):
    meta = paper.get("meta", {})
    from .library import Library
    from .organization import Organization, assignment, paper_id
    item = ws.load("item") or {}
    organization = Organization(Library(ws.root.parent), [ws]).load() if organization is None else organization
    effective = assignment(organization, paper_id(ws), item.get("tags"))
    meta = {**meta, **{k: v for k, v in (item.get("meta_override") or {}).items() if v}}
    yield "题录", "", " ".join(str(meta.get(k) or "") for k in ("title_en", "title_zh", "authors", "venue", "doi", "year", "abstract_en")) + " " + " ".join(effective["tags"])
    blocks = {b.get("id"): b for b in paper.get("blocks", [])}
    for bid, block in blocks.items():
        parts = [str(block.get(k) or "") for k in ("en", "zh", "caption_en", "caption_zh", "tex")]
        parts += [str(v.get(k) or "") for v in block.get("items", []) for k in ("en", "zh")]
        parts += [str(c) for row in block.get("head", []) + block.get("rows", []) for c in row]
        yield "正文", bid or "", " ".join(parts)
    reader = ws.load("reader") or {}
    for key, edit in reader.get("edits", {}).items():
        if not edit.get("reverted"):
            yield "修改后的译文", key.split("#")[0], str(edit.get("zh") or "")
    yield "精读卡", "", str((reader.get("paper_note") or {}).get("body") or "")
    for note in reader.get("notes", {}).values():
        if not note.get("deleted"):
            yield "笔记", note.get("anchor") or "", str(note.get("body") or "") + " " + str(note.get("quote") or "")
    for entry in (ws.load("discussion") or {}).get("entries", []):
        yield "AI 批注", entry.get("anchor") or "", " ".join(str(entry.get(k) or "") for k in ("title", "body", "q"))
    chat = ws.load("chat") or {}
    messages = list(chat.get("messages") or [])
    for thread in chat.get("threads", []):
        messages.extend(thread.get("messages") or [])
    for message in messages:
        yield "AI 对话", message.get("anchor") or "", str(message.get("content") or "")


def find(lib, query: str, limit: int = 200) -> dict:
    query = query.strip()[:200]
    words = query.casefold().split()
    if not words:
        return {"matches": [], "errors": [], "truncated": False}
    from .organization import Organization
    organization = Organization(lib).load()
    matches, errors = [], []
    truncated = False
    for ws in lib.all():
        try:
            paper = ws.load("paper") or {}
            hits = []
            # Every search word must occur in the same passage, so the snippet is evidence.
            for kind, anchor, text in _entries(ws, paper, organization):
                lower = text.casefold()
                if all(word in lower for word in words):
                    at = lower.find(words[0])
                    hits.append({"kind": kind, "anchor": anchor, "page": next((b.get("page") for b in paper.get("blocks", []) if b.get("id") == anchor), None),
                                 "snippet": text[max(0, at - 45):at + 155]})
                    if len(hits) == 3:
                        break
            if hits:
                matches.append({"id": ws.id, "hits": hits})
                if len(matches) >= limit:
                    truncated = True
                    break
        except (ValueError, OSError, TypeError, KeyError) as exc:
            errors.append({"id": ws.id, "error": type(exc).__name__})
    return {"matches": matches, "errors": errors, "truncated": truncated}
