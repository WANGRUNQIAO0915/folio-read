"""文献库：一个目录里放多篇论文，每篇一个子目录（目录名就是 id，取 PDF 的 SHA-256 前 12 位）。"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from datetime import datetime
from pathlib import Path

from . import sources
from .store import SCHEMA, Workspace, empty_discussion, empty_reader, now_iso, read_json, write_json_atomic



def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Library:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def ws(self, pid: str) -> Workspace | None:
        if not re.fullmatch(r"[A-Za-z0-9_\-]{4,64}", pid or ""):
            return None
        p = self.root / pid
        return Workspace(p) if (p / "paper.json").exists() else None

    def all(self) -> list[Workspace]:
        return [Workspace(p) for p in sorted(self.root.iterdir()) if p.is_dir() and not p.name.startswith(".") and (p / "paper.json").exists()]

    # ---------- 列表摘要 ----------
    def summary(self, ws: Workspace, organization=None) -> dict:
        from .scholar import visible_rank
        from .organization import Organization, assignment, paper_id
        organization = Organization(self).load() if organization is None else organization
        classification = assignment(organization, paper_id(ws))
        paper = ws.load("paper") or {}
        meta = dict(paper.get("meta", {}))
        item = ws.load("item") or {}
        meta.update({k: v for k, v in (item.get("meta_override") or {}).items() if v})
        reader = ws.load("reader") or {}
        disc = ws.load("discussion") or {}
        job = ws.load("job") or {}
        tr = paper.get("translation", {})
        notes = [n for n in reader.get("notes", {}).values() if not n.get("deleted")]
        replied = {e.get("reply_to") for e in disc.get("entries", []) if e.get("reply_to")}
        abstract = next((b.get("zh") for b in paper.get("blocks", []) if b.get("role") == "abstract"), "") or meta.get("abstract_en", "")
        status = item.get("status", "unread")
        progress = reader.get("progress") or {}
        # Older readers saved progress without updating the initial unread status.
        if status == "unread" and not item.get("status_manual") and (
            progress.get("ratio", 0) > 0 or progress.get("block") not in (None, "head")
        ):
            status = "reading"
        return {
            "id": ws.id,
            "title_zh": meta.get("title_zh", ""), "title_en": meta.get("title_en", ""), "short_zh": meta.get("short_zh", ""),
            "authors": meta.get("authors", ""), "affiliation": meta.get("affiliation", ""),
            "year": meta.get("year") or _year(meta.get("date", "")), "date": meta.get("date", ""),
            "venue": meta.get("venue", ""), "arxiv": meta.get("arxiv", ""), "url": _link(meta), "doi": meta.get("doi", ""),
            "journal_rank": visible_rank(meta),
            "pages": meta.get("page_count", 0), "done_pages": len(tr.get("done_pages", [])),
            "abstract": abstract,
            "meta_override": item.get("meta_override") or {},
            "organization_id": paper_id(ws), "folder_id": classification["folder_id"], "organization_version": classification["version"],
            "tags": classification["tags"], "status": status, "starred": bool(item.get("starred")),
            "added": item.get("added", ""), "last_opened": item.get("last_opened", ""),
            "progress": (reader.get("progress") or {}).get("ratio", 0),
            "notes": len([n for n in notes if n.get("kind") != "highlight"]),
            "highlights": len([n for n in notes if n.get("kind") == "highlight"]),
            "open_questions": len([n for n in notes if n.get("kind") == "question" and n["id"] not in replied]),
            "discussions": len(disc.get("entries", [])),
            "has_paper_note": bool((reader.get("paper_note") or {}).get("body")),
            "job": {k: job.get(k) for k in ("type", "state", "message", "done", "total", "updated", "error", "failed", "scope")} if job else None,
            "thumb": f"/p/{ws.id}/pages/page-001.webp" if (ws.root / "pages" / "page-001.webp").exists() else "",
        }

    def list(self) -> list[dict]:
        from .organization import Organization
        organization = Organization(self).load()
        return [self.summary(ws, organization) for ws in self.all()]

    # ---------- 导入 ----------
    def create_from_pdf(self, data: bytes, filename: str, meta: dict | None = None) -> tuple[Workspace, bool]:
        """建目录、落 PDF 和空数据文件。渲染原页、抽文字放到后台任务里做。返回 (目录, 是否新建)。"""
        if not data.startswith(b"%PDF"):
            raise ValueError("不是 PDF 文件")
        digest = sha256_bytes(data)
        pid = digest[:12]
        ws = Workspace(self.root / pid)
        if (ws.root / "paper.json").exists():
            return ws, False
        ws.root.mkdir(parents=True, exist_ok=True)
        (ws.root / "source.pdf").write_bytes(data)
        base_meta = {"title_zh": "", "title_en": "", "authors": "", "source": filename, "source_sha256": digest, "pdf": "source.pdf"}
        base_meta.update(meta or {})
        if not base_meta.get("title_en"):
            base_meta["title_en"] = _pdf_title(ws.root / "source.pdf") or Path(filename).stem
        write_json_atomic(ws.paper_path, {
            "schema": SCHEMA, "meta": base_meta,
            "translation": {"scope": "未开始", "done_pages": [], "note": ""},
            "glossary": [], "references": [], "blocks": [],
        })
        write_json_atomic(ws.discussion_path, empty_discussion())
        write_json_atomic(ws.reader_path, empty_reader())
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "unread", "starred": False})
        return ws, True

    def fetch(self, ref: str) -> tuple[bytes, str, dict]:
        """链接、arXiv 编号、DOI、标题 → (PDF, 文件名, 元数据)。见 sources.py。"""
        return sources.fetch(ref)

    def trash(self, pid: str) -> Path:
        ws = self.ws(pid)
        if not ws:
            raise KeyError(pid)
        dest = self.root / ".trash" / f"{pid}-{datetime.now():%Y%m%d%H%M%S}"
        dest.parent.mkdir(exist_ok=True)
        shutil.move(str(ws.root), dest)
        return dest

    def find_by_sha(self, digest: str) -> Workspace | None:
        return self.ws(digest[:12])


def _year(date: str) -> str:
    m = re.search(r"(19|20)\d{2}", date or "")
    return m.group(0) if m else ""


def _pdf_title(path: Path) -> str:
    try:
        import pypdf
        t = (pypdf.PdfReader(str(path)).metadata or {}).get("/Title", "") or ""
        return str(t).strip()
    except Exception:  # noqa: BLE001
        return ""


def migrate_folder(src: Path, lib: Library) -> Workspace:
    """把旧版技能生成的“xxx-共读”目录搬进文献库。"""
    src = Path(src)
    data = (src / "source.pdf").read_bytes()
    pid = sha256_bytes(data)[:12]
    dest = lib.root / pid
    if not dest.exists():
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("server.json", "*.html", "打开共读.cmd", ".write.lock"))
    ws = Workspace(dest)
    if not ws.item_path.exists():
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "reading", "starred": False})
    reader = read_json(ws.reader_path, {}) or {}
    reader.setdefault("paper_note", {})
    write_json_atomic(ws.reader_path, reader)
    return ws



def _link(meta: dict) -> str:
    """论文主页链接：填了就用；否则由 arXiv 编号或 DOI 推出来。"""
    if meta.get("url"):
        return meta["url"]
    m = sources.ARXIV_RE.search(meta.get("arxiv") or meta.get("source") or "")
    if m and (meta.get("arxiv") or re.fullmatch(r"\d{4}\.\d{4,5}(v\d+)?\.pdf", meta.get("source") or "")):
        aid = re.sub(r"v\d+$", "", m.group(1))  # f-string 里不能有反斜杠（Python 3.10/3.11）
        return f"https://arxiv.org/abs/{aid}"
    return f"https://doi.org/{meta['doi']}" if meta.get("doi") else ""

if __name__ == "__main__":  # 调试用：打印库摘要
    import sys
    print(json.dumps(Library(Path(sys.argv[1])).list(), ensure_ascii=False, indent=1))
