"""本地服务：只监听 127.0.0.1。文献库页、阅读页、数据接口、导入、后台任务。"""
from __future__ import annotations

import json
import mimetypes
import os
import sys
import threading

import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import __version__, chat, chat_models, chat_store, cli_models, config, detect, engines, figures, paperdata, pdfwork, personal, prefs, search
from .log import log, setup as setup_log, tail
from .jobs import Jobs
from . import research, study
from .library import Library
from .store import now_iso, write_json_atomic

WEB = config.WEB
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
MAX_UPLOAD = 200 * 1024 * 1024


def _safe(base: Path, rel: str) -> Path | None:
    target = (base / rel).resolve()
    return target if target.is_relative_to(base.resolve()) and target.is_file() else None


class App:
    def __init__(self, cfg: dict):
        self.lib = Library(config.library_dir(cfg))
        from .classification import Classification
        self.classification = Classification(self.lib)
        from .naming import Naming
        self.naming = Naming(self.lib)
        self.jobs = Jobs(self.lib)
        self.study = study.Tasks(self.lib)
        self.token = os.urandom(12).hex()
        from .drive import Drive
        self.drive = Drive(config.HOME, self.lib)
        from .scholar import Scholar
        self.scholar = Scholar(config.HOME, self.lib)


class Handler(BaseHTTPRequestHandler):
    app: App
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---------- 输出 ----------
    def _send(self, code: int, body: bytes, ctype: str, cache: bool = False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _file(self, path: Path | None, cache=False):
        if not path:
            return self._json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype, cache)

    def _download(self, body: bytes, filename: str, ctype: str, disposition="attachment"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        extension = Path(filename).suffix if Path(filename).suffix in ('.html', '.zip', '.md', '.ris', '.pdf') else '.bin'
        self.send_header("Content-Disposition", f"{disposition}; filename=\"export{extension}\"; filename*=UTF-8''{quote(filename)}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _chat(self, ws, body: dict):
        """流式回答：一行一个 JSON，{"t": 片段} … 最后 {"done": true, "id": …} 或 {"error": …}。"""
        text = (body.get("text") or "").strip()
        if not text:
            raise ValueError("问题是空的")
        cfg = config.load()
        ecfg, m = chat_models.engine_cfg(cfg, body.get("model"))
        model = chat_models.label(m)
        thread = chat_store.get(ws, body.get("thread"))
        tid = thread["id"] if thread else chat_store.new_id()
        refs = [{"anchor": str(r.get("anchor") or ""), "quote": str(r.get("quote") or "")[:1000]}
                for r in (body.get("refs") or [])[:12] if isinstance(r, dict) and r.get("anchor")]
        first = refs[0] if refs else {}
        user = {"content": text, "anchor": body.get("anchor") or first.get("anchor"), "quote": (body.get("quote") or first.get("quote") or "")[:1000],
                "note": body.get("note"), "refs": refs}
        past = (thread or {}).get("messages", [])
        convo = [{"role": x["role"], "content": x["content"]} for x in past] + [{"role": "user", "content": text}]
        prompt_text = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        cancel = threading.Event()
        pieces: list[str] = []

        def send(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        try:
            send({"model": model, "thread": tid})
            def seen(actual):
                chat_models.remember(m.get("model", ""), actual)
                if m.get("engine") == "claude":
                    send({"model": chat_models.label(m)})
            for piece in chat.stream(ecfg, prompt_text, ws.root, cancel, seen):
                pieces.append(piece)
                send({"t": piece})
            msg = chat_store.append(ws, tid, user, "".join(pieces), m["id"], model)
            send({"done": True, "id": msg["id"]})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            cancel.set()  # 读者点了停止或关了页面
            if pieces:
                chat_store.append(ws, tid, {**user, "note": None}, "".join(pieces) + "\n\n（已停止）", m["id"], model)
        except engines.Cancelled:
            pass
        except Exception as e:  # noqa: BLE001
            log.exception("对话出错 %s", ws.id)
            try:
                send({"error": str(e)[:500]})
            except OSError:
                pass

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", "0"))
        if n < 0:
            raise ValueError("请求长度不能为负数")
        if n > MAX_UPLOAD:
            raise ValueError("文件太大")
        return self.rfile.read(n) if n else b""

    def _local_request(self) -> bool:
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            hosts |= {"127.0.0.1", "localhost"}
        origin = self.headers.get("Origin")
        if self.headers.get("Host", "").lower() not in hosts or (origin and origin.lower() not in {"http://" + h for h in hosts}):
            self.close_connection = True
            self._json(403, {"error": "仅允许来自本机阅读页面的请求"})
            return False
        return True

    # ---------- GET ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._local_request():
            return
        try:
            self._get()
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _get(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        app, lib = self.app, self.app.lib
        if path in ("/", "/index.html"):
            return self._file(WEB / "library.html")
        if path.startswith("/read/"):
            return self._file(WEB / "reader.html")
        if path in ("/study", "/study/"):
            return self._file(WEB / "study.html")
        if path.startswith("/web/"):
            return self._file(_safe(WEB, path[5:]), cache=path.startswith("/web/vendor/"))
        if path == "/api/organization":
            from .organization import Organization
            return self._json(200, Organization(lib).load())
        if path == "/api/library":
            from .organization import Organization
            cfg = config.load()
            app.scholar.refresh(automatic=True)
            return self._json(200, {"items": lib.list(), "organization": Organization(lib).load(), "token": app.token, "jobs": app.jobs.small_status(),
                                    "engine": cfg.get("engine"), "engine_label": _engine_label(cfg),
                                    "first_run": config.is_first_run(), "version": __version__})
        if path == "/api/config":
            return self._json(200, {"config": config.public(config.load()), "presets": config.PRESETS, "groups": config.PRESET_GROUPS})
        if path == '/api/drive':
            return self._json(200, app.drive.status())
        if path == '/api/easyscholar':
            return self._json(200, app.scholar.status())
        if path == "/api/engines":
            cfg = config.load()
            found = detect.detect(cfg, fresh=parse_qs(url.query).get("fresh") == ["1"])
            return self._json(200, {"found": found, "ready": detect.ready(cfg, found), "engine": cfg.get("engine"), "models": cli_models.listing()})
        if path == "/api/prefs":
            return self._json(200, prefs.load())
        if path == "/api/personal":
            return self._json(200, {"preferences": personal.load(), "profiles": personal.PROFILES})
        if path == "/api/search":
            return self._json(200, search.find(lib, parse_qs(url.query).get("q", [""])[0]))
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if path == "/api/research":
            return self._json(200, research.view(lib))
        if path == "/api/study/history":
            return self._json(200, {"runs": study.history(query.get('paper', ''))})
        if path == "/api/study/run":
            return self._json(200, study.saved(query.get('id', '')))
        if path in ("/api/study/meta", "/api/study/image"):
            ws = lib.ws(query.get('paper', ''))
            if not ws:
                return self._json(404, {'error': '找不到论文'})
            if path.endswith('/meta'):
                return self._json(200, study.metadata(ws))
            image = study.image_bytes(ws, query.get('asset', ''))
            return self._send(200, image, 'image/jpeg') if image else self._json(404, {'error': '没有可用原页图'})
        if path == "/api/research/export":
            tid, fmt = query.get('topic', ''), query.get('format', 'zip')
            base = 'http://127.0.0.1:' + str(self.server.server_address[1])
            if fmt == 'md':
                return self._download(research.markdown(research.view(lib), tid, lib, base).encode('utf-8'), '研究主题.md', 'text/markdown; charset=utf-8')
            if fmt == 'ris':
                return self._download(research.ris(tid, lib, base).encode('utf-8'), '研究主题.ris', 'application/x-research-info-systems; charset=utf-8')
            return self._download(research.export_bundle(tid, lib, base), 'Obsidian-研究主题.zip', 'application/zip')
        if path == "/api/zotero/search":
            return self._json(200, research.zotero_search(query.get('q', '')))
        if path == "/api/chat/models":
            return self._json(200, chat_models.listing(config.load()))
        if path == "/api/log":
            return self._json(200, {"text": tail(config.LOG_PATH, 200), "path": str(config.LOG_PATH)})
        if path == "/api/jobs":
            return self._json(200, {"jobs": app.jobs.small_status(parse_qs(url.query).get("pid", [None])[0])})
        if path.startswith("/api/p/"):
            parts = path.split("/")  # ['', 'api', 'p', id, action, name?]
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": "没有这篇论文"})
            action = parts[4]
            if action == "pdf":
                from .naming import library_filenames
                source = _safe(ws.root, "source.pdf")
                if not source:
                    return self._json(404, {"error": "没有可下载的原始 PDF"})
                return self._download(source.read_bytes(), library_filenames(lib)[ws.id], "application/pdf")
            if action == "state":
                from .links import for_reader
                ws.patch_item({"last_opened": now_iso()})
                _warm(ws.root)
                _warm_figures(ws)
                return self._json(200, {
                    **{n: ws.load(n) for n in ("paper", "discussion", "reader", "layout", "item", "job")},
                    "paper": for_reader(ws),
                    "versions": ws.versions(), "token": app.token, "id": ws.id,
                    "engine": config.load().get("engine")})
            if action == "versions":
                return self._json(200, ws.versions())
            if action == "chat":
                return self._json(200, {"threads": chat_store.threads(ws), **chat_models.listing(config.load())})
            if action == "log":
                return self._json(200, {"text": tail(ws.root / "job.log", 300)})
            if action == "export":
                from .build import build
                out = build(ws)
                return self._download(out.read_bytes(), out.name, "text/html; charset=utf-8")
            if action == "part" and len(parts) > 5 and parts[5] in ("paper", "discussion", "reader", "layout", "job"):
                from .links import for_reader
                data = for_reader(ws) if parts[5] == 'paper' else ws.load(parts[5])
                return self._json(200, {"data": data, "version": ws.versions()[parts[5]]})
        if path.startswith("/p/"):
            _, _, pid, rel = path.split("/", 3)
            ws = lib.ws(pid)
            if ws and rel.startswith("pages/") and "w=" in url.query:  # 原页面板用的小一号图，第一次请求时生成
                return self._file(pdfwork.page_variant(ws.root, rel, int(parse_qs(url.query)["w"][0])), cache=True)
            if ws and rel == "source.pdf":
                from .naming import library_filenames
                source = _safe(ws.root, rel)
                if source:
                    return self._download(source.read_bytes(), library_filenames(lib)[ws.id], "application/pdf", "inline")
            if ws and (rel.split("/", 1)[0] in ("pages", "figures") or rel == "source.pdf"):
                return self._file(_safe(ws.root, rel), cache=rel != "source.pdf")
        return self._json(404, {"error": "not found"})

    # ---------- POST ----------
    def do_POST(self):
        if not self._local_request():
            return
        if self.headers.get("X-Token") != self.app.token:  # 挡住别的网页跨站写
            self.close_connection = True
            return self._json(403, {"error": "bad token"})
        try:
            self._post()
        except (ValueError, KeyError) as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _post(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        app, lib = self.app, self.app.lib

        if path.startswith('/api/naming/'):
            body = json.loads(self._body() or b'{}')
            if not isinstance(body, dict):
                raise ValueError('请求必须是对象')
            if path == '/api/naming/suggest':
                return self._json(200, app.naming.suggest(body))
            if path == '/api/naming/preview':
                return self._json(200, app.naming.preview(body, config.load()))
            if path == '/api/naming/send':
                return self._json(200, app.naming.send(body.get('id'), body.get('confirmed'), config.load()))
            if path == '/api/naming/cancel':
                return self._json(200, app.naming.cancel(body.get('id')))
            if path == '/api/naming/apply':
                return self._json(200, app.naming.apply(body.get('suggestions')))
            raise ValueError('未知命名操作')

        if path.startswith('/api/organization/') or path.startswith('/api/classification/'):
            body = json.loads(self._body() or b'{}')
            if not isinstance(body, dict):
                raise ValueError('请求必须是对象')
            from .organization import Organization
            organization = Organization(lib)
            if path == '/api/organization/folder':
                return self._json(200, organization.folder(body.get('name'), body.get('id')))
            if path == '/api/organization/folder-delete':
                return self._json(200, organization.delete_folder(body.get('id')))
            if path == '/api/organization/assign':
                return self._json(200, organization.assign(body.get('assignments')))
            if path == '/api/classification/preview':
                return self._json(200, app.classification.preview(body, config.load()))
            if path == '/api/classification/send':
                return self._json(200, app.classification.send(body.get('id'), body.get('confirmed'), config.load()))
            if path == '/api/classification/cancel':
                return self._json(200, app.classification.cancel(body.get('id')))
            raise ValueError('未知分类操作')

        if path.startswith('/api/easyscholar/'):
            body = json.loads(self._body() or b'{}')
            if not isinstance(body, dict):
                raise ValueError('请求必须是对象')
            action = path.rsplit('/', 1)[-1]
            if action == 'config':
                return self._json(200, app.scholar.configure(body))
            if action == 'lookup':
                ws = lib.ws(str(body.get('paper_id') or ''))
                if not ws:
                    raise ValueError('找不到论文')
                result = app.scholar.lookup(ws, body.get('publication_name'), bool(body.get('force')))
                return self._json(200, {'journal_rank': result})
            if action == 'refresh':
                app.scholar.refresh(force=bool(body.get('force')))
                return self._json(200, app.scholar.status())
            raise ValueError('未知期刊分区操作')

        if path.startswith('/api/drive/'):
            body = json.loads(self._body() or b'{}')
            action = path.rsplit('/', 1)[-1]
            if action == 'config':
                app.drive.configure(body)
            elif action == 'select':
                if app.drive.busy:
                    raise ValueError('请等同步结束后再修改选择')
                app.drive.select(body.get('ids', []),sync_all=bool(body.get('sync_all',False)))
            elif action == 'folder-import':
                if body.get('enabled') is True:
                    app.drive.run('login', True)
                elif body.get('enabled') is False:
                    app.drive.disable_folder_import()
                else:
                    raise ValueError('请明确选择是否启用文件夹导入')
            elif action in ('login', 'sync'):
                app.drive.run(action)
            elif action == 'pull':
                app.drive.run('pull', str(body.get('file_id') or ''))
            elif action == 'disconnect':
                app.drive.disconnect()
            else:
                raise ValueError('未知云盘操作')
            return self._json(200, app.drive.status())

        if path == "/api/import":  # 请求体就是 PDF 文件
            from .organization import Organization
            organization = Organization(lib)
            try:
                fid = organization.validate_folder(q.get("folder_id"))
            except ValueError:
                self.close_connection = True  # The rejected PDF body is intentionally unread.
                raise
            data = self._body()
            ws, fresh = lib.create_from_pdf(data, q.get("name", "paper.pdf"))
            if fresh:
                if fid:
                    organization.assign([{"paper_id": ws.id, "folder_id": fid}])
                app.jobs.enqueue(ws, translate_after=q.get("translate", "1") == "1", scope=q.get("scope"))
            return self._json(200, {"id": ws.id, "new": fresh})
        if path in ("/api/import-url", "/api/import-arxiv"):
            body = json.loads(self._body() or b"{}")
            from .organization import Organization
            organization = Organization(lib)
            fid = organization.validate_folder(body.get("folder_id"))
            data, name, meta = lib.fetch(body.get("ref", ""))  # sources.SourceError 是 ValueError，回 400
            ws, fresh = lib.create_from_pdf(data, name, meta)
            if fresh:
                if fid:
                    organization.assign([{"paper_id": ws.id, "folder_id": fid}])
                app.jobs.enqueue(ws, translate_after=bool(body.get("translate", True)), scope=body.get("scope"))
            return self._json(200, {"id": ws.id, "new": fresh})
        if path == "/api/config":
            patch = json.loads(self._body() or b"{}")
            patch.pop("library_dir", None)
            if isinstance(patch.get("openai"), dict):
                patch["openai"] = config.with_key(patch["openai"])
            cfg = config.save(patch)
            return self._json(200, {"config": config.public(cfg)})
        if path == "/api/prefs":
            return self._json(200, prefs.save(json.loads(self._body() or b"{}")))
        if path == "/api/personal":
            return self._json(200, {"preferences": personal.save(json.loads(self._body() or b"{}"))})
        if path == "/api/chat/models":  # 设置页保存名单和默认模型；或面板里只改默认
            body = json.loads(self._body() or b"{}")
            patch = {}
            if "models" in body:
                patch["models"] = chat_models.sanitize(body["models"])
            if body.get("default"):
                patch["default"] = str(body["default"])
            full = {"chat": patch}
            if isinstance(body.get("keys"), dict):  # 设置里给某家 API 填的 Key，和翻译那边共用
                keys = dict(config.load()["openai"].get("keys") or {})
                keys.update({str(k): str(v).strip() for k, v in body["keys"].items() if v and not str(v).startswith("••••")})
                full["openai"] = {"keys": keys}
            config.save(full)
            return self._json(200, chat_models.listing(config.load()))
        if path == "/api/config/test":
            cfg = config.load()
            patch = json.loads(self._body() or b"{}")
            if patch.get("engine"):
                cfg["engine"] = patch["engine"]
            return self._json(200, engines.test(cfg))

        if path.startswith('/api/study/') or path.startswith('/api/research/') or path == '/api/zotero/link':
            body = json.loads(self._body() or b'{}')
            if not isinstance(body, dict):
                raise ValueError('请求必须是对象')
            if path == '/api/study/run':
                return self._json(200, app.study.submit(body))
            if path == '/api/study/cancel':
                app.study.cancel(str(body.get('id') or ''))
                return self._json(200, {'ok': True})
            if path == '/api/research/topic':
                return self._json(200, research.topic_save(body))
            if path == '/api/research/record':
                fields = {k: body[k] for k in ('id', 'topic', 'text', 'comment', 'kind', 'status') if k in body}
                old = next((r for r in research.load()['records'] if r['id'] == fields.get('id')), None)
                if fields.get('kind') == 'source' and old and old['text'] == fields.get('text'):
                    fields['kind'] = old['kind']
                else:
                    fields['kind'] = 'question' if fields.get('kind') == 'question' else 'judgment'
                if not old and body.get('paper'):
                    ws = lib.ws(str(body['paper']))
                    if not ws:
                        raise ValueError('找不到关联论文')
                    meta = ws.load('paper').get('meta', {})
                    fields['_evidence'] = [{'paper': ws.id, 'title': meta.get('title_zh') or meta.get('title_en') or ws.id,
                                            'anchor': '', 'page': None, 'quote': '', 'origin': '读者关联', 'url': '/read/' + quote(ws.id)}]
                return self._json(200, research.record_save(fields))
            if path == '/api/research/pin':
                return self._json(200, study.pin(body))
            if path == '/api/research/collect':
                ws = lib.ws(str(body.get('paper') or ''))
                if not ws:
                    raise ValueError('找不到论文')
                return self._json(200, {'added': research.collect_reader(ws, str(body.get('topic') or ''))})
            if path == '/api/zotero/link':
                pid = str(body.get('paper') or '')
                if not lib.ws(pid):
                    raise ValueError('找不到论文')
                return self._json(200, research.zotero_link(pid, str(body.get('key') or '')))

        if path.startswith("/api/p/"):
            parts = path.split("/")
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": "没有这篇论文"})
            action = parts[4]
            body = json.loads(self._body() or b"{}")
            if action == "figure":
                if not isinstance(body, dict):
                    raise ValueError("截图请求必须是对象")
                fields = figures.set_crop(ws, str(body.get("id") or ""), body.get("page"), body.get("box"))
                return self._json(200, {"ok": True, **fields})
            if action == "chat" and len(parts) > 5:
                sub, tid = parts[5], body.get("thread", "")
                if sub == "pin":
                    chat_store.pin(ws, tid, body.get("id", ""))
                elif sub == "rename":
                    chat_store.rename(ws, tid, body.get("title", ""))
                elif sub == "delete":
                    chat_store.delete(ws, tid)
                return self._json(200, {"threads": chat_store.threads(ws)})
            if action == "chat":
                return self._chat(ws, body)
            if action == "ops":
                ops = body.get("ops") or []
                if not isinstance(ops, list):
                    raise ValueError("ops 必须是数组")
                res = ws.apply_reader_ops(ops, client=str(body.get("client", ""))[:40])
                res["versions"] = ws.versions()
                return self._json(200, res)
            if action == "item":
                return self._json(200, ws.patch_item(body))
            if action == "translate":
                pages = paperdata.parse_pages(body["pages"]) if body.get("pages") else None
                if body.get("failed"):  # 只重试上次没译成功的页
                    pages = sorted(int(k) for k in ((ws.load("job") or {}).get("failed") or {}))
                    if not pages:
                        return self._json(200, {"ok": True, "message": "没有失败页需要重试"})
                app.jobs.enqueue(ws, pages=pages, translate_after=True, scope=body.get("scope"))
                return self._json(200, {"ok": True})
            if action == "reveal":  # 在资源管理器 / 访达里打开这篇的文件夹
                _reveal(ws.root)
                return self._json(200, {"ok": True})
            if action == "cancel":
                app.jobs.cancel(ws.id)
                return self._json(200, {"ok": True})
            if action == "answer":
                return self._json(200, app.jobs.submit_small("answer", ws.id, note=body["note"]))
            if action == "retranslate":
                return self._json(200, app.jobs.submit_small("retranslate", ws.id, key=body["key"], hint=body.get("hint", "")))
            if action == "delete":
                app.jobs.cancel(ws.id)
                return self._json(200, {"trash": str(lib.trash(ws.id))})
        return self._json(404, {"error": "not found"})


_warming: set[str] = set()
_figure_warming: set[str] = set()
_figure_warm_lock = threading.Lock()


def _warm_figures(ws) -> None:
    """为已有译文补上图片，后台运行；页面通过现有轮询自动更新。"""
    if not figures.pending(ws):
        return
    key = str(ws.root)
    with _figure_warm_lock:
        if key in _figure_warming:
            return
        _figure_warming.add(key)

    def run():
        try:
            figures.ensure(ws)
        except Exception:  # noqa: BLE001
            log.exception("生成正文配图失败 %s", ws.id)
        finally:
            with _figure_warm_lock:
                _figure_warming.discard(key)
    threading.Thread(target=run, daemon=True).start()


def _warm(root: Path) -> None:
    """打开一篇论文时，后台生成原页面板用的小图（每篇只做一次）。"""
    if str(root) in _warming or (root / "pages" / f"w{pdfwork.PANEL_WIDTH}").exists() and \
            len(list((root / "pages" / f"w{pdfwork.PANEL_WIDTH}").glob("*.webp"))) >= len(list((root / "pages").glob("page-*.webp"))):
        return
    _warming.add(str(root))

    def run():
        try:
            pdfwork.warm_variants(root)
        except Exception:  # noqa: BLE001
            log.exception("生成面板图失败 %s", root)
        finally:
            _warming.discard(str(root))
    threading.Thread(target=run, daemon=True).start()


def _engine_label(cfg: dict) -> str:
    e = cfg.get("engine")
    if e == "openai":
        preset = next((p["name"] for p in config.PRESETS if p["id"] == cfg["openai"].get("preset")), "API")
        return f"{preset.split('（')[0]} · {cfg['openai'].get('model') or '未填模型'}"
    return engines.ENGINE_NAMES.get(e, e or "")


def _reveal(path: Path):
    import subprocess
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def serve(port: int | None = None, open_browser: bool = False, path: str = "/"):
    setup_log(config.LOG_PATH)
    cfg = config.load()
    app = App(cfg)
    Handler.app = app
    detect.warm(cfg)
    port = cfg["port"] if port is None else port
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    if not config.temp_library():
        write_json_atomic(config.SERVER_INFO, {"url": url, "pid": os.getpid(), "started": now_iso()})
    log.info("Folio Read %s 已启动：%s  文献库：%s", __version__, url, app.lib.root)
    print(f"Folio Read 已启动：{url}  文献库：{app.lib.root}", flush=True)
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url + path)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
