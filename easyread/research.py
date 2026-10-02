"""Local research themes, source snapshots, Markdown/Obsidian and Zotero bridges."""
from __future__ import annotations

import io
import json
import re
import uuid
import urllib.error
import urllib.request
import zipfile
from urllib.parse import quote, urlencode

from . import config
from . import evidence
from .store import dir_lock, now_iso, read_json, write_json_atomic


def load() -> dict:
    return read_json(config.HOME / 'research.json', {'topics': [], 'records': [], 'zotero': {}})


def view(lib) -> dict:
    data = load()
    for record in data['records']:
        for src in record.get('evidence', []):
            ws = lib.ws(src['paper'])
            if not ws:
                src['unresolved'] = True
                continue
            if src.get('origin') == '我的笔记':
                reader = ws.load('reader') or {}
                note = reader.get('paper_note', {}) if src.get('note_id') == 'paper' else reader.get('notes', {}).get(src.get('note_id'), {})
                src['unresolved'] = bool(note.get('deleted') or not note or evidence.compact(src.get('quote', '')) not in evidence.compact(note.get('body', '')))
                continue
            if not src.get('anchor'):
                # Quotes from untranslated PDFs point to extracted pages rather
                # than translated blocks; those sources can change as well.
                quoted = evidence.compact(src.get('quote') or '')
                if quoted and src.get('page'):
                    try:
                        page = int(src['page'])
                        path = next((p for p in (ws.root / 'extract').glob('page-*.txt')
                                     if p.stem[5:].isdigit() and int(p.stem[5:]) == page), None)
                        src['unresolved'] = path is None or quoted not in evidence.compact(path.read_text(encoding='utf-8', errors='replace'))
                    except (OSError, TypeError, ValueError):
                        src['unresolved'] = True
                continue
            block = next((b for b in ws.load('paper').get('blocks', []) if b.get('id') == src['anchor']), None)
            quoted = evidence.compact(src.get('quote') or '')
            src['unresolved'] = not block or bool(quoted and not any(quoted in evidence.compact(evidence.block_text(block, lang)) for lang in ('en', 'zh')))
    return data


def change(fn):
    config.HOME.mkdir(parents=True, exist_ok=True)
    with dir_lock(config.HOME, '.research.lock'):
        data = load()
        result = fn(data)
        write_json_atomic(config.HOME / 'research.json', data)
        return result


def topic_save(body: dict) -> dict:
    title = str(body.get('title') or '').strip()[:160]
    if not title:
        raise ValueError('请填写研究主题名称')
    def apply(data):
        tid = body.get('id') or 'topic-' + uuid.uuid4().hex[:12]
        topic = next((t for t in data['topics'] if t['id'] == tid), None)
        if not topic:
            topic = {'id': tid, 'created': now_iso()}
            data['topics'].append(topic)
        topic.update(title=title, question=str(body.get('question') or '')[:4000], updated=now_iso())
        return topic
    return change(apply)


def record_save(body: dict) -> dict:
    def apply(data):
        if not any(t['id'] == body.get('topic') for t in data['topics']):
            raise ValueError('请先选择一个研究主题')
        text = str(body.get('text') or '').strip()[:12000]
        if not text:
            raise ValueError('记录内容不能为空')
        rid = body.get('id') or 'note-' + uuid.uuid4().hex[:12]
        rec = next((r for r in data['records'] if r['id'] == rid), None)
        if not body.get('id') and body.get('_source_key'):
            existing = next((r for r in data['records'] if r.get('source_key') == body['_source_key'] and r['topic'] == body['topic']), None)
            if existing:
                return existing
        if not rec:
            rec = {'id': rid, 'created': now_iso()}
            data['records'].append(rec)
        kind = body.get('kind', 'judgment')
        rec.update(topic=body['topic'], text=text, kind=kind if kind in ('source', 'judgment', 'question') else 'judgment',
                   comment=str(body.get('comment') or '')[:6000], updated=now_iso(),
                   status='done' if body.get('status') == 'done' else 'open')
        # Evidence is provided by a server-side verified result, never arbitrary browser input.
        if '_evidence' in body:
            rec['evidence'] = body['_evidence']
            rec['source_key'] = body.get('_source_key', '')
        return rec
    return change(apply)


def collect_reader(ws, tid: str) -> int:
    reader = ws.load('reader') or {}
    paper = ws.load('paper') or {}
    blocks = {b['id']: b for b in paper.get('blocks', [])}
    candidates = [(str(nid), n) for nid, n in reader.get('notes', {}).items() if not n.get('deleted')]
    if (reader.get('paper_note') or {}).get('body'):
        candidates.append(('paper', {'body': reader['paper_note']['body']}))
    def apply(data):
        if not any(t['id'] == tid for t in data['topics']):
            raise ValueError('请先选择研究主题')
        existing = {r.get('source_key') for r in data['records'] if r['topic'] == tid}
        added = 0
        for nid, note in candidates:
            key = 'reader:' + ws.id + ':' + nid
            if key in existing:
                continue
            anchor = note.get('anchor', '')
            block = blocks.get(anchor, {})
            quoted = note.get('quote') or ''
            title = paper.get('meta', {}).get('title_zh') or paper.get('meta', {}).get('title_en') or ws.id
            evidence = [{'paper': ws.id, 'title': title, 'anchor': anchor, 'page': block.get('page'), 'quote': quoted,
                         'origin': '阅读批注', 'url': '/read/' + quote(ws.id) + ('#b-' + quote(anchor) if anchor else ''),
                         'unresolved': bool(anchor and not block)}]
            data['records'].append({'id': 'note-' + uuid.uuid4().hex[:12], 'topic': tid, 'source_key': key,
                                    'kind': 'question' if note.get('kind') == 'question' else 'judgment',
                                    'text': note.get('body') or quoted or '划线', 'comment': '', 'evidence': evidence,
                                    'status': 'open', 'created': now_iso(), 'updated': now_iso()})
            added += 1
        return added
    return change(apply)


def _safe_name(text: str) -> str:
    return re.sub(r'[<>:"/\\|?*\[\]\x00-\x1f]', '-', text).strip('. ')[:90] or '未命名'


def markdown(data: dict, tid: str, lib, base: str) -> str:
    topic = next((t for t in data['topics'] if t['id'] == tid), None)
    if not topic:
        raise ValueError('没有这个研究主题')
    lines = ['---', 'title: ' + json.dumps(topic['title'], ensure_ascii=False), 'type: research-topic',
             'topic_id: ' + tid, '---', '', '# ' + topic['title'], '', topic.get('question', ''), '']
    kinds = {'source': '论文内容（AI 提取，需核对）', 'judgment': '我的判断 / AI 解释', 'question': '待核实问题'}
    for record in [r for r in data['records'] if r['topic'] == tid]:
        lines += ['## ' + kinds.get(record['kind'], '研究记录'), '', record['text'], '']
        if record.get('comment'):
            lines += ['我的补充：' + record['comment'], '']
        if record['kind'] == 'question':
            lines += ['状态：' + ('已处理' if record.get('status') == 'done' else '待处理'), '']
        for src in record.get('evidence', []):
            ws = lib.ws(src['paper'])
            meta = (ws.load('paper') or {}).get('meta', {}) if ws else {}
            filename = _safe_name(src['title']) + '-' + src['paper']
            url = meta.get('url') or ('https://doi.org/' + meta['doi'] if meta.get('doi') else '')
            lines += ['- 论文：[[' + filename + ']]', '- 位置：第 ' + str(src.get('page') or '?') + ' 页 · ' + src.get('origin', '来源'),
                      '- 阅读位置：[回到段落](' + base + src['url'] + ')']
            if url:
                lines += ['- 原文链接：' + url]
            if src.get('quote'):
                lines += ['> ' + src['quote'].replace('\n', '\n> ')]
            if src.get('unresolved'):
                lines += ['> 原段落位置已变化，需要重新定位。']
            lines += ['']
    return '\n'.join(lines)


def export_bundle(tid: str, lib, base: str) -> bytes:
    data = view(lib)
    records = [r for r in data['records'] if r['topic'] == tid]
    topic = next((t for t in data['topics'] if t['id'] == tid), None)
    if not topic:
        raise ValueError('没有这个研究主题')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(_safe_name(topic['title']) + '.md', markdown(data, tid, lib, base))
        papers = {s['paper']: s for r in records for s in r.get('evidence', [])}
        for pid, source in papers.items():
            ws = lib.ws(pid)
            if not ws:
                continue
            meta = ws.load('paper').get('meta', {})
            text = ('---\ntitle: ' + json.dumps(source['title'], ensure_ascii=False) + '\n'
                    'doi: ' + json.dumps(meta.get('doi', '')) + '\n'
                    'authors: ' + json.dumps(meta.get('authors', ''), ensure_ascii=False) + '\n---\n\n'
                    '# ' + source['title'] + '\n\n' + meta.get('url', '') + '\n\n'
                    '研究主题：[[' + _safe_name(topic['title']) + ']]\n\n'
                    '[打开阅读器](' + base + '/read/' + quote(pid) + ')\n')
            for r in records:
                for s in r.get('evidence', []):
                    if s['paper'] == pid:
                        text += '\n> ' + s.get('quote', '').replace('\n', '\n> ') + '\n\n第 ' + str(s.get('page') or '?') + ' 页\n'
            archive.writestr(_safe_name(source['title']) + '-' + pid + '.md', text)
        archive.writestr('研究记录.json', json.dumps({'topic': topic, 'records': records}, ensure_ascii=False, indent=2))
        archive.writestr('Zotero-研究笔记.ris', ris(tid, lib, base))
    return out.getvalue()


def ris(tid: str, lib, base: str) -> str:
    data = view(lib)
    if not any(t['id'] == tid for t in data['topics']):
        raise ValueError('没有这个研究主题')
    grouped = {}
    for record in data['records']:
        if record['topic'] == tid:
            for pid in {s['paper'] for s in record.get('evidence', [])}:
                grouped.setdefault(pid, []).append(record)
    lines = []
    clean = lambda value: ' '.join(str(value or '').split())
    for pid, records in grouped.items():
        ws = lib.ws(pid)
        if not ws:
            continue
        meta = ws.load('paper').get('meta', {})
        lines += ['TY  - JOUR', 'TI  - ' + clean(meta.get('title_en') or meta.get('title_zh'))]
        for author in str(meta.get('authors') or '').split(','):
            if author.strip():
                lines += ['AU  - ' + clean(author)]
        for tag, field in [('DO', 'doi'), ('PY', 'date'), ('JO', 'venue'), ('UR', 'url')]:
            if meta.get(field):
                lines += [tag + '  - ' + clean(meta[field])]
        for rec in records:
            note = rec['kind'] + ': ' + rec['text'] + '\n' + rec.get('comment', '')
            for s in rec.get('evidence', []):
                if s['paper'] == pid:
                    note += '\n第 ' + str(s.get('page') or '?') + ' 页：' + s.get('quote', '') + ' ' + base + s['url']
            lines += ['N1  - ' + clean(note)]
        lines += ['ER  - ', '']
    return '\n'.join(lines)


def zotero_search(query: str) -> dict:
    address = 'http://127.0.0.1:23119/api/users/0/items?' + urlencode({'q': query[:200], 'format': 'json', 'limit': 30})
    req = urllib.request.Request(address, headers={'Zotero-API-Version': '3'})
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            data = json.loads(response.read(2_000_000))
        items = []
        for item in data:
            d = item.get('data', {})
            if d.get('itemType') in ('attachment', 'note'):
                continue
            key = item.get('key') or d.get('key', '')
            items.append({'key': key, 'title': d.get('title', ''), 'doi': d.get('DOI', ''), 'date': d.get('date', ''),
                          'url': 'zotero://select/library/items/' + key})
        return {'available': True, 'items': items}
    except (OSError, ValueError, urllib.error.URLError) as exc:
        return {'available': False, 'items': [], 'message': 'Zotero 本机服务未就绪。请打开 Zotero 并启用本机 API；也可导出 RIS。'}


def zotero_link(pid: str, key: str) -> dict:
    if not re.fullmatch(r'[A-Z0-9]{8}', key):
        raise ValueError('Zotero 条目编号不正确')
    # Link only existing, read-only local records; never silently create duplicates.
    address = 'http://127.0.0.1:23119/api/users/0/items/' + key
    try:
        with urllib.request.urlopen(urllib.request.Request(address, headers={'Zotero-API-Version': '3'}), timeout=3) as response:
            item = json.loads(response.read(1_000_000))
    except (OSError, ValueError) as exc:
        raise ValueError('无法核对 Zotero 条目，请检查本机连接') from exc
    value = {'key': key, 'title': item.get('data', {}).get('title', ''), 'url': 'zotero://select/library/items/' + key}
    def apply(data):
        data.setdefault('zotero', {})[pid] = value
        return value
    return change(apply)
