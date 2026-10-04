"""Logical folders and per-paper classification, independent of paper/reader content.

Schema 1 is shared with web/js/common/organization.js. Folder deletions are
permanent remove-wins tombstones. Assignment registers use timestamp, event id,
then canonical UTF-16 JSON as a deterministic tie break. No PDF path is changed.
"""
from __future__ import annotations

import copy
import re
import uuid
from datetime import datetime, timezone

from .portable import canonical, safe_key as _safe_key, timestamp
from .store import dir_lock, read_json, write_json_atomic

MAX_NAME = 80
MAX_TAGS = 12
MAX_TAG = 40
MAX_BATCH = 500


def _length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def safe_key(value):
    return _safe_key(value) and _length(value) < 200


def empty():
    return {'schema': 1, 'folders': {}, 'assignments': {}}


def name(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > MAX_NAME:
        raise ValueError('文件夹名称须为 1–80 个字符')
    if any(ord(c) < 32 for c in value):
        raise ValueError('文件夹名称不能包含控制字符')
    return value.strip()


def tags(value, strict=True, generous=False):
    limit, width = (MAX_TAGS, MAX_TAG) if strict and not generous else (500, 500)
    if not isinstance(value, list) or len(value) > limit:
        if strict:
            raise ValueError(f'标签须为数组，最多 {limit} 个')
        value = value if isinstance(value, list) else []
    out, seen = [], set()
    for tag in value:
        valid = isinstance(tag, str) and 0 < len(tag.strip()) <= width and not any(ord(c) < 32 for c in tag)
        if not valid:
            if strict:
                raise ValueError(f'每个标签须为 1–{width} 个字符')
            continue
        tag = tag.strip()
        if tag.lower() not in seen:
            seen.add(tag.lower()); out.append(tag)
    return out[:limit]


def clean_version(value):
    if not isinstance(value, dict) or not isinstance(value.get('at'), str) or not isinstance(value.get('id'), str) or _length(value['id']) > 200:
        return {'at': '', 'id': ''}
    try:
        if value['at']:
            datetime.fromisoformat(value['at'].replace('Z', '+00:00'))
    except (ValueError, OverflowError):
        return {'at': '', 'id': ''}
    return {'at': value['at'], 'id': value['id']}


def normalize(value=None):
    out = empty()
    if not isinstance(value, dict):
        return out
    for fid, record in (value.get('folders') if isinstance(value.get('folders'), dict) else {}).items():
        if not safe_key(fid) or not isinstance(record, dict):
            continue
        try:
            label = name(record.get('name'))
        except ValueError:
            continue
        out['folders'][fid] = {'id': fid, 'name': label, 'version': clean_version(record.get('version')), 'deleted': record.get('deleted') is True}
    for pid, record in (value.get('assignments') if isinstance(value.get('assignments'), dict) else {}).items():
        if not safe_key(pid) or not isinstance(record, dict):
            continue
        fid = record.get('folder_id')
        out['assignments'][pid] = {'folder_id': fid if safe_key(fid) else None, 'tags': tags(record.get('tags', []), False), 'version': clean_version(record.get('version'))}
    return out


def _order(record):
    version = record.get('version') or {}
    return (int(timestamp(version.get('at')) * 1000), str(version.get('id') or '').encode('utf-16-be'), canonical(record).encode('utf-16-be'))


def merge(*states):
    out = empty()
    for state in states:
        state = normalize(state)
        for kind in ('folders', 'assignments'):
            for key, value in state[kind].items():
                current = out[kind].get(key)
                if current is None or (kind == 'folders' and value['deleted'] != current['deleted'] and value['deleted']) or (
                    (kind != 'folders' or value['deleted'] == current['deleted']) and _order(value) > _order(current)
                ):
                    out[kind][key] = copy.deepcopy(value)
    return out


def assignment(state, pid, fallback=None):
    record = copy.deepcopy(state.get('assignments', {}).get(pid) or {'folder_id': None, 'tags': tags(fallback or [], False), 'version': {'at': '', 'id': ''}})
    folder = state.get('folders', {}).get(record.get('folder_id'))
    if not folder or folder.get('deleted'):
        record['folder_id'] = None
    return record


def paper_id(ws):
    digest = (ws.load('paper') or {}).get('meta', {}).get('source_sha256')
    return digest.lower() if isinstance(digest, str) and re.fullmatch('[a-fA-F0-9]{64}', digest) else ws.id


def subset(state, pids):
    state = normalize(state)
    return {**state, 'assignments': {k: v for k, v in state['assignments'].items() if k in set(pids)}}


def export_subset(state, pids):
    state = subset(state, pids)
    referenced = {a['folder_id'] for a in state['assignments'].values()}
    state['folders'] = {fid: folder for fid, folder in state['folders'].items() if fid in referenced}
    return state


def has_data(state):
    state = normalize(state)
    return bool(state['folders'] or any(a['folder_id'] or a['tags'] or a['version']['at'] or a['version']['id'] for a in state['assignments'].values()))


def version(state):
    # Local actions must order after records already observed, even after clock drift.
    latest = max([timestamp(r['version']['at']) for kind in ('folders', 'assignments') for r in state[kind].values()] + [0])
    at = max(datetime.now(timezone.utc).timestamp(), latest + .001)
    return {'at': datetime.fromtimestamp(at, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'id': str(uuid.uuid4())}


class Organization:
    def __init__(self, lib, workspaces=None):
        self.lib = lib
        self.workspaces = workspaces
        self.path = lib.root / '.organization.json'

    def load(self):
        stored = read_json(self.path, {})
        if stored and (not isinstance(stored, dict) or stored.get('schema') != 1 or not isinstance(stored.get('folders'), dict) or not isinstance(stored.get('assignments'), dict)):
            raise ValueError('分类资料格式无效，请保留原文件并恢复备份')
        out = normalize(stored)
        for ws in self.lib.all() if self.workspaces is None else self.workspaces:
            try:
                pid = paper_id(ws)
                if pid not in out['assignments']:
                    out['assignments'][pid] = {'folder_id': None, 'tags': tags((ws.load('item') or {}).get('tags', []), False), 'version': {'at': '', 'id': ''}}
            except (ValueError, OSError, TypeError, AttributeError):
                # One damaged paper must not hide folders or other papers' tags.
                # Paper readers/search retain their existing per-paper error reports.
                continue
        return out

    def merge(self, *states):
        with dir_lock(self.lib.root, '.organization.lock'):
            out = merge(self.load(), *states)
            write_json_atomic(self.path, out)
            return out

    def resolve(self, pid):
        if not isinstance(pid, str):
            raise ValueError('论文标识无效')
        ws = self.lib.ws(pid) or next((w for w in self.lib.all() if paper_id(w) == pid), None)
        if not ws:
            raise ValueError('找不到论文')
        return paper_id(ws)

    def validate_folder(self, fid, state=None):
        if fid is None or fid == '':
            return None
        state = state if state is not None else self.load()
        if not isinstance(fid, str) or fid not in state['folders'] or state['folders'][fid]['deleted']:
            raise ValueError('文件夹不存在或已删除')
        return fid

    def folder(self, label, fid=None):
        label = name(label)
        with dir_lock(self.lib.root, '.organization.lock'):
            state = self.load()
            if fid is not None:
                self.validate_folder(fid, state)
            match = next((f for f in state['folders'].values() if not f['deleted'] and f['name'].lower() == label.lower() and f['id'] != fid), None)
            if match:
                raise ValueError('已有同名文件夹')
            fid = fid or str(uuid.uuid4())
            state['folders'][fid] = {'id': fid, 'name': label, 'version': version(state), 'deleted': False}
            write_json_atomic(self.path, state)
            return state

    def delete_folder(self, fid):
        if not isinstance(fid, str):
            raise ValueError('文件夹标识无效')
        with dir_lock(self.lib.root, '.organization.lock'):
            state = self.load()
            if fid not in state['folders']:
                raise ValueError('文件夹不存在')
            if not state['folders'][fid]['deleted']:
                state['folders'][fid].update(deleted=True, version=version(state))
                write_json_atomic(self.path, state)
            return state

    def assign(self, rows):
        if not isinstance(rows, list) or not rows or len(rows) > MAX_BATCH:
            raise ValueError('一次请选择 1–500 篇论文')
        with dir_lock(self.lib.root, '.organization.lock'):
            state = self.load()
            seen = set()
            # Validate and stage the entire request before one atomic replacement.
            for row in rows:
                if not isinstance(row, dict):
                    raise ValueError('分类记录必须是对象')
                pid = self.resolve(row.get('paper_id'))
                if pid in seen:
                    raise ValueError('论文标识重复')
                seen.add(pid)
                prior = assignment(state, pid)
                if 'expected_version' in row and row['expected_version'] != prior['version']:
                    raise ValueError('分类已在另一处更新，请刷新后重试')
                chosen_tags = tags(row['tags'], generous=True) if 'tags' in row else prior['tags']
                fid = row.get('folder_id', prior['folder_id'])
                if row.get('folder_name'):
                    if row.get('folder_id'):
                        raise ValueError('不能同时指定已有和新建文件夹')
                    label = name(row['folder_name'])
                    found = next((f for f in state['folders'].values() if not f['deleted'] and f['name'].lower() == label.lower()), None)
                    if found:
                        fid = found['id']
                    else:
                        fid = str(uuid.uuid4())
                        state['folders'][fid] = {'id': fid, 'name': label, 'version': version(state), 'deleted': False}
                fid = self.validate_folder(fid, state)
                state['assignments'][pid] = {'folder_id': fid, 'tags': chosen_tags, 'version': version(state)}
            write_json_atomic(self.path, state)
            return state
