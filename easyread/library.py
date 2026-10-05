"""文献库：一个目录里放多篇论文，每篇一个子目录（目录名就是 id，取 PDF 的 SHA-256 前 12 位）。"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import uuid
from contextlib import contextmanager
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
        self._lifecycle = threading.RLock()
        self._active: dict[str | None, int] = {}

    @contextmanager
    def activity(self, pid: str | None = None):
        """Keep a workspace in place until a request/background writer finishes."""
        with self._lifecycle:
            ws = self.ws(pid) if pid is not None else None
            if pid is not None and ws is None:
                raise KeyError('论文已删除或不存在')
            if ws is not None:
                pid = ws.id  # Windows identifiers may arrive with different casing.
            self._active[pid] = self._active.get(pid, 0) + 1
        try:
            yield ws
        finally:
            with self._lifecycle:
                self._active[pid] -= 1
                if not self._active[pid]:
                    del self._active[pid]

    def ws(self, pid: str) -> Workspace | None:
        if not re.fullmatch(r"[A-Za-z0-9_\-]{4,64}", pid or ""):
            return None
        p = self.root / pid
        if p.resolve() != p or p.is_symlink():
            return None
        return Workspace(p) if (p / "paper.json").exists() else None

    def all(self) -> list[Workspace]:
        return [ws for p in sorted(self.root.iterdir()) if not p.name.startswith('.') and (ws := self.ws(p.name))]

    # ---------- 列表摘要 ----------
    def summary(self, ws: Workspace, organization=None, naming_filenames=None) -> dict:
        from .scholar import visible_rank
        from .naming import clean_naming, display_title, library_filenames
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
            "display_title": display_title(paper, item, ws.id),
            "pdf_filename": (naming_filenames if naming_filenames is not None else library_filenames(self))[ws.id],
            "naming": clean_naming(item.get("naming")),
            "title_zh": meta.get("title_zh", ""), "title_en": meta.get("title_en", ""), "short_zh": meta.get("short_zh", ""),
            "authors": meta.get("authors", ""), "affiliation": meta.get("affiliation", ""),
            "year": meta.get("year") or _year(meta.get("date", "")), "date": meta.get("date", ""),
            "venue": meta.get("venue", ""), "arxiv": meta.get("arxiv", ""), "url": _link(meta), "doi": meta.get("doi", ""),
            "journal_rank": visible_rank(meta),
            "volume": meta.get("volume", ""), "issue": meta.get("issue", ""), "citation_pages": meta.get("citation_pages") or meta.get("page_range", ""), "article_number": meta.get("article_number", ""),
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
        with self._lifecycle:
            organization = Organization(self).load()
            from .naming import library_filenames
            filenames = library_filenames(self)
            return [self.summary(ws, organization, filenames) for ws in self.all()]

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
        with self._lifecycle:
            ws = self.ws(pid)
            if not ws:
                raise KeyError('论文已删除或不存在')
            pid = ws.id
            if self._active.get(pid) or self._active.get(None):
                raise ValueError('论文正在处理或同步，请等当前操作结束后再删除')
            if (ws.load('job') or {}).get('state') in ('queued', 'running'):
                raise ValueError('论文正在排队或翻译，请先取消任务，等停止后再删除')
            folder = self._trash_root()
            folder.mkdir(exist_ok=True)
            dest = folder / f'{pid}-{datetime.now():%Y%m%d%H%M%S}-{uuid.uuid4().hex[:8]}'
            write_json_atomic(ws.root / '.trashed.json', {'paper_id': pid, 'deleted_at': now_iso()})
            try:
                ws.root.rename(dest)
            except OSError:
                (ws.root / '.trashed.json').unlink(missing_ok=True)
                raise ValueError('论文文件仍被占用，请关闭原 PDF 或等待当前操作结束后再删除') from None
            return dest

    def _trash_root(self) -> Path:
        folder = self.root / '.trash'
        if folder.resolve() != folder or folder.is_symlink():
            raise ValueError('回收站路径无效')
        return folder

    def _trash_entry(self, tid: str) -> tuple[Path, str, dict]:
        if not isinstance(tid, str) or not re.fullmatch(r'[A-Za-z0-9_\-]{4,100}', tid):
            raise ValueError('回收站条目标识无效')
        folder = self._trash_root()
        path = folder / tid
        if path.resolve() != path or path.is_symlink() or not (path / 'paper.json').is_file():
            raise ValueError('回收站条目不存在或路径无效')
        marker = read_json(path / '.trashed.json', {})
        legacy = re.fullmatch(r'([A-Za-z0-9_\-]{4,64})-(\d{14})(?:-[a-f0-9]{8})?', tid)
        pid = marker.get('paper_id') or (legacy.group(1) if legacy else '')
        if not re.fullmatch(r'[A-Za-z0-9_\-]{4,64}', pid):
            raise ValueError('无法识别原论文目录')
        at = marker.get('deleted_at') or (datetime.strptime(legacy.group(2), '%Y%m%d%H%M%S').astimezone().isoformat() if legacy else '')
        return path, pid, {'deleted_at': at}

    def trash_list(self) -> list[dict]:
        from .naming import display_title
        with self._lifecycle:
            folder = self._trash_root()
            if not folder.exists():
                return []
            rows = []
            for entry in folder.iterdir():
                try:
                    path, pid, info = self._trash_entry(entry.name)
                    paper = read_json(path / 'paper.json', {})
                    item = read_json(path / 'item.json', {})
                    meta = dict(paper.get('meta') or {})
                    meta.update({k: v for k, v in (item.get('meta_override') or {}).items() if v})
                    rows.append({'id': entry.name, 'paper_id': pid, **info,
                                 'title': display_title(paper, item, pid), 'title_en': meta.get('title_en', ''),
                                 'source_id': meta.get('source_sha256') or pid,
                                 'done_pages': len((paper.get('translation') or {}).get('done_pages') or []),
                                 'notes': sum(not n.get('deleted') for n in (read_json(path / 'reader.json', {}).get('notes') or {}).values()),
                                 'can_restore': not (self.root / pid).exists()})
                except (ValueError, OSError, TypeError, json.JSONDecodeError):
                    continue
            return sorted(rows, key=lambda row: row['deleted_at'], reverse=True)

    def trashed_ids(self) -> set[str]:
        with self._lifecycle:
            removed = read_json(self.root / '.deleted.json', {'ids': []})
            return set(removed.get('ids') or []) | {key for row in self.trash_list() for key in (row['paper_id'], row['source_id'])}

    def restore(self, tid: str) -> str:
        with self._lifecycle:
            path, pid, _ = self._trash_entry(tid)
            if (self.root / pid).exists():
                raise ValueError('资料库已有同一篇论文，不能覆盖；请先处理现有副本')
            if self._active.get(None):
                raise ValueError('资料库正在同步或更新，请稍后恢复')
            job = read_json(path / 'job.json', {})
            if job.get('state') in ('queued', 'running'):
                job.update(state='cancelled', message='已恢复，旧任务未自动重启，已保存译文保留', updated=now_iso())
                write_json_atomic(path / 'job.json', job)
            path.rename(self.root / pid)
            (self.root / pid / '.trashed.json').unlink(missing_ok=True)
            return pid

    def purge(self, tid: str) -> None:
        with self._lifecycle:
            path, pid, _ = self._trash_entry(tid)
            # The entire resolved target must be a direct child of our recycle bin.
            # Reject links inside it as well, including Windows junctions.
            pending = [path]
            while pending:
                for child in pending.pop().iterdir():
                    if child.is_symlink() or child.resolve() != child or getattr(child, 'is_junction', lambda: False)():
                        raise ValueError('回收站条目含链接，请先检查文件')
                    if child.is_dir():
                        pending.append(child)
            # Remember local removal so background Drive sync cannot recreate it.
            source_id = (read_json(path / 'paper.json', {}).get('meta') or {}).get('source_sha256') or pid
            removed = read_json(self.root / '.deleted.json', {'ids': []})
            write_json_atomic(self.root / '.deleted.json', {'ids': sorted(set(removed.get('ids') or []) | {pid, source_id})})
            shutil.rmtree(path)

    def trash_batch(self, action: str, ids: list[str]) -> dict:
        if action not in ('delete', 'restore', 'purge'):
            raise ValueError('未知回收站操作')
        if not isinstance(ids, list) or not ids or len(ids) > 500 or any(not isinstance(i, str) for i in ids):
            raise ValueError('请选择 1–500 篇论文')
        results = []
        for key in dict.fromkeys(ids):
            try:
                value = getattr(self, {'delete': 'trash', 'restore': 'restore', 'purge': 'purge'}[action])(key)
                results.append({'id': key, 'ok': True, 'result': value.name if isinstance(value, Path) else value})
            except (ValueError, KeyError, OSError) as error:
                results.append({'id': key, 'ok': False, 'error': str(error)})
        return {'results': results}

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
