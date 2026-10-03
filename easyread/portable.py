"""Private portable document format and deterministic annotation merge.

The matching browser implementation is web/mobile/core.js. Credentials and
machine configuration are never part of a document package.
"""
from __future__ import annotations

import copy
import json
import re
import uuid
from datetime import datetime, timezone

MAX_BYTES = 64 * 1024 * 1024
FIELDS = {
    'meta': 'title_zh title_en short_zh authors affiliation year date venue arxiv url doi page_count source_sha256 abstract_en source pages pdf text_status extraction_note',
    'block': 'id type level num appendix zh en page role ordered items tex tag src caption_zh caption_en head rows source_links',
    'note': 'id anchor key quote prefix suffix segments lang root_index kind color style body created updated deleted _syncConflicts',
    'segment': 'anchor key quote prefix suffix lang root_index',
    'edit': 'zh base at reverted prev',
    'item': 'tags status starred rating meta_override added updated last_opened archived status_manual',
    'link': 'url label page rect',
    'reference': 'id text url doi',
    'entry': 'id anchor quote kind title q body at updated reply_to',
    'translation': 'done_pages note',
}


def safe_key(key):
    return isinstance(key, str) and 0 < len(key) < 200 and key not in ('__proto__', 'prototype', 'constructor')


def pick(value, kind):
    value = value if isinstance(value, dict) else {}
    return {k: copy.deepcopy(value[k]) for k in FIELDS[kind].split() if k in value}


def timestamp(value):
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return dt.replace(tzinfo=timezone.utc).timestamp() if dt.tzinfo is None else dt.timestamp()
    except (ValueError, TypeError, OverflowError):
        return 0


def canonical(value):
    def clean(v):
        if isinstance(v, dict):
            return {k: clean(v[k]) for k in sorted(v, key=lambda s: s.encode('utf-16-be')) if safe_key(k) and not k.startswith('_sync')}
        if isinstance(v, list):
            return [clean(i) for i in v]
        if isinstance(v, float) and v.is_integer():
            return int(v)
        return v
    return json.dumps(clean(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def clean_note(note):
    out = pick(note, 'note')
    if 'segments' in out:
        out['segments'] = [pick(s, 'segment') for s in out['segments']]
    if '_syncConflicts' in out:
        out['_syncConflicts'] = [pick(n, 'note') for n in out['_syncConflicts']]
        for n in out['_syncConflicts']:
            n.pop('_syncConflicts', None)
    return out


def clean_reader(reader=None):
    reader = reader or {}
    progress, pn = reader.get('progress') or {}, reader.get('paper_note') or {}
    return {'schema': 2, 'rev': 0,
            'notes': {k: clean_note(n) for k, n in (reader.get('notes') or {}).items() if safe_key(k) and isinstance(n, dict) and n.get('id') == k},
            'edits': {k: pick(e, 'edit') for k, e in (reader.get('edits') or {}).items() if safe_key(k)},
            'progress': {'block': progress.get('block'), 'ratio': max(0, min(1, float(progress.get('ratio') or 0))), 'at': progress.get('at') or ''},
            'paper_note': {'body': pn.get('body') or '', 'at': pn.get('at') or ''}}


def normalize(data):
    paper = data.get('paper') or {}
    if not isinstance(paper.get('meta'), dict) or not isinstance(paper.get('blocks'), list):
        raise ValueError('不是 Folio Read 阅读文件')
    digest = paper['meta'].get('source_sha256', '')
    pid = digest.lower() if re.fullmatch('[a-fA-F0-9]{64}', str(digest)) else data.get('paper_id')
    if not safe_key(pid):
        raise ValueError('论文缺少同步标识')
    ids = [b.get('id') for b in paper['blocks']]
    if any(not safe_key(i) for i in ids) or len(ids) != len(set(ids)):
        raise ValueError('论文段落标识无效或重复')
    from .scholar import clean_rank
    meta = pick(paper['meta'], 'meta')
    rank = clean_rank(paper['meta'].get('journal_rank'))
    if rank:
        meta['journal_rank'] = rank
    if 'pages' in meta:
        meta['pages'] = [{k: p[k] for k in ('n', 'img') if k in p} for p in meta['pages']]
    blocks = []
    for block in paper['blocks']:
        b = pick(block, 'block')
        if 'items' in b:
            b['items'] = [{'zh': i.get('zh') or '', 'en': i.get('en') or ''} for i in b['items']]
        if 'source_links' in b:
            b['source_links'] = [pick(l, 'link') for l in b['source_links']]
        blocks.append(b)
    item = pick(data.get('item'), 'item')
    if 'meta_override' in item:
        item['meta_override'] = pick(item['meta_override'], 'meta')
    clean_paper={'schema': 2, 'meta': meta, 'blocks': blocks, 'references': [pick(r, 'reference') for r in paper.get('references', [])]}
    if isinstance(paper.get('translation'),dict):
        clean_paper['translation']=pick(paper['translation'],'translation')
        clean_paper['translation']['done_pages']=sorted({p for p in paper['translation'].get('done_pages',[]) if isinstance(p,int) and 0<p<=10000})
    return {'schema': 1, 'kind': 'folio-mobile-paper', 'paper_id': pid,
            'paper': clean_paper,
            'reader': clean_reader(data.get('reader')),
            'discussion': {'entries': [pick(e, 'entry') for e in (data.get('discussion') or {}).get('entries', [])]},
            'item': item, 'images': {k: v for k, v in (data.get('images') or {}).items() if safe_key(k) and isinstance(v, str) and re.fullmatch(r'data:image/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\s]+', v)},
            'imported_at': data.get('imported_at') or datetime.now(timezone.utc).isoformat()}


def cloud_op(reader, op, event_id=None):
    fields = {'note': (), 'note_del': ('id', 'at'), 'progress': ('block', 'ratio', 'at'), 'paper_note': ('body', 'at'), 'edit': ('block', 'zh', 'base', 'at')}.get(op.get('op'))
    if fields is None:
        raise ValueError('不支持的阅读操作')
    out = {k: copy.deepcopy(op[k]) for k in fields if k in op}
    out.update(op=op['op'], event_id=event_id or str(uuid.uuid4()))
    if op['op'] == 'note':
        out['note'] = clean_note(op['note'])
    if op.get('op') in ('note', 'note_del'):
        prior = reader.get('notes', {}).get((op.get('note') or {}).get('id') or op.get('id'))
        out['base_version'] = canonical(clean_note(prior)) if prior else None
        if op.get('resolve_conflicts') and prior:
            out['parent_versions'] = [canonical(clean_note(prior))] + [canonical(clean_note(n)) for n in prior.get('_syncConflicts', [])]
    return out


def materialize(bases, events):
    from .store import apply_ops, empty_reader
    reader, groups, seen = empty_reader(), {}, set()
    def add(note, parent=None):
        if not note or not safe_key(note.get('id')):
            return
        version = canonical(note)
        entry = groups.setdefault(note['id'], {}).setdefault(version, {'note': clean_note(note), 'parents': set()})
        if parent and parent != version:
            entry['parents'].add(parent)
        for conflict in note.get('_syncConflicts', []):
            add(conflict)
    for base in bases:
        for note in (base.get('notes') or {}).values():
            add(note)
        ops = [dict(e, op='edit', block=k, zh=None if e.get('reverted') else e.get('zh')) for k, e in (base.get('edits') or {}).items()]
        for field in ('progress', 'paper_note'):
            if (base.get(field) or {}).get('at'):
                ops.append(dict(base[field], op=field))
        apply_ops(reader, ops)
    for event in events:
        eid = event.get('event_id') if isinstance(event, dict) else None
        if not eid or eid in seen:
            continue
        seen.add(eid)
        kind = event.get('op')
        if kind in ('note', 'note_del'):
            if kind == 'note':
                note = event.get('note')
            else:
                try:
                    prior = json.loads(event.get('base_version') or '{}')
                except (ValueError, TypeError):
                    prior = {}
                note = dict(prior, id=event.get('id'), deleted=True, updated=event.get('at'))
                note.pop('_syncConflicts', None)
            add(note, event.get('base_version'))
            for parent in event.get('parent_versions', []):
                add(note, parent)
        else:
            apply_ops(reader, [event])
    for nid, group in groups.items():
        superseded = set().union(*(e['parents'] for e in group.values()))
        tips = [e['note'] for ver, e in group.items() if ver not in superseded]
        tips.sort(key=lambda n: (timestamp(n.get('updated') or n.get('at') or n.get('created')), canonical(n).encode('utf-16-be')))
        if tips:
            winner = copy.deepcopy(tips[-1])
            winner.pop('_syncConflicts', None)
            if len(tips) > 1:
                winner['_syncConflicts'] = []
                for n in tips[:-1]:
                    n = copy.deepcopy(n); n.pop('_syncConflicts', None)
                    winner['_syncConflicts'].append(n)
            reader['notes'][nid] = winner
    return reader


def reader_events(reader, device):
    ops = []
    for note in reader.get('notes', {}).values():
        for n in [note] + note.get('_syncConflicts', []):
            op = {'op': 'note', 'note': clean_note(n), 'base_version': None}
            ops.append(dict(op, event_id=device + ':' + canonical(op)))
    for k, e in reader.get('edits', {}).items():
        ops.append(dict(e, op='edit', block=k, zh=None if e.get('reverted') else e.get('zh'), event_id=f'{device}:edit:{k}:{e.get("at")}'))
    for field in ('progress', 'paper_note'):
        if (reader.get(field) or {}).get('at'):
            ops.append(dict(reader[field], op=field, event_id=f'{device}:{field}:{reader[field]["at"]}'))
    return ops


def capture_ops(before, ops):
    """Cloud outbox lives inside reader.json, atomically with local changes."""
    from .store import apply_ops
    shadow = copy.deepcopy(before)
    pending = list((before.get('_cloud') or {}).get('pending') or [])
    for op in ops:
        event = cloud_op(shadow, op)
        apply_ops(shadow, [op])
        pending.append(event)
    progress = [i for i, e in enumerate(pending) if e.get('op') == 'progress']
    return [e for i, e in enumerate(pending) if e.get('op') != 'progress' or i == progress[-1]]
