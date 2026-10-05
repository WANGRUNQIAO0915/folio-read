"""EasyScholar journal metadata. Keys stay local; only normalized results travel."""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .store import now_iso, read_json, write_json_atomic

API = 'https://www.easyscholar.cc/open/getPublicationRank'
LABELS = {
    'sciUp': '中科院（升级版）', 'sci': 'JCR · SCI', 'ssci': 'JCR · SSCI',
    'sciif': '影响因子（JCR）', 'sciUpSmall': '中科院 · 小类', 'sciUpTop': '中科院 · Top',
    'sciBase': '中科院（基础版）', 'sciif5': '五年影响因子', 'jci': 'JCI',
    'ccf': 'CCF', 'cssci': 'CSSCI', 'pku': '北大核心', 'sciwarn': '中科院预警',
    'cscd': 'CSCD', 'eii': 'EI', 'ahci': 'A&HCI', 'ajg': 'AJG / ABS',
    'fms': 'FMS', 'ft50': 'FT50', 'utd24': 'UTD24', 'esi': 'ESI',
    'zhongguokejihexin': '中国科技核心', 'xr': '新锐学术', 'xrWarn': '新锐学术预警',
    'xrTop': '新锐学术 · Top', 'xrSmall': '新锐学术 · 小类',
    'swufe': '西南财经大学', 'cufe': '中央财经大学', 'uibe': '对外经济贸易大学',
    'sdufe': '山东财经大学', 'xdu': '西安电子科技大学', 'swjtu': '西南交通大学',
    'ruc': '中国人民大学', 'xmu': '厦门大学', 'sjtu': '上海交通大学', 'fdu': '复旦大学',
    'hhu': '河海大学', 'scu': '四川大学', 'cqu': '重庆大学', 'nju': '南京大学',
    'xju': '新疆大学', 'cug': '中国地质大学', 'cju': '长江大学', 'zju': '浙江大学',
    'cpu': '中国药科大学',
}


def publication_name(value):
    name = ' '.join(unicodedata.normalize('NFKC', str(value or '')).split())
    if len(name) > 256 or any(ord(c) < 32 for c in name):
        raise ValueError('期刊名称过长或包含无效字符')
    return name


def queryable(value):
    name = publication_name(value)
    return bool(name) and not re.search(
        r'^(?:arxiv|biorxiv|medrxiv|preprint|预印本|openreview|acl anthology)(?:\b|:|\s|$)|^\d{4}\.\d{4,5}(?:v\d+)?(?:\.pdf)?$', name, re.I)


def clean_rank(value):
    """Whitelist nested metadata so credentials cannot ride in a reading file."""
    if not isinstance(value, dict) or value.get('source') != 'easyScholar':
        return None
    try:
        name = publication_name(value.get('publication'))
    except ValueError:
        return None
    if not name:
        return None
    metrics = []
    raw_metrics = value.get('metrics')
    for m in (raw_metrics if isinstance(raw_metrics, list) else [])[:60]:
        if not isinstance(m, dict):
            continue
        key = str(m.get('key') or '')[:80]
        if key not in LABELS and not re.fullmatch(r'custom:[\w-]{1,64}', key):
            continue
        label = LABELS.get(key) or str(m.get('label') or '')[:60]
        text = m.get('value')
        if not isinstance(text, (str, int, float)) or isinstance(text, bool):
            continue
        text = str(text).strip()[:500]
        if label and text:
            metrics.append(dict(key=key, label=label, value=text))
    at = str(value.get('queried_at') or '')[:40]
    try:
        datetime.fromisoformat(at.replace('Z', '+00:00'))
    except ValueError:
        at = ''
    return dict(source='easyScholar', publication=name, queried_at=at,
                status='found' if metrics else 'not_found', metrics=metrics)


def visible_rank(meta):
    result = clean_rank(meta.get('journal_rank'))
    try:
        if result and result['publication'].casefold() == publication_name(meta.get('venue')).casefold():
            return result
    except ValueError:
        pass
    return None


def parse_result(payload, name):
    if not isinstance(payload, dict) or payload.get('code') != 200:
        if isinstance(payload, dict) and payload.get('code') == 40002:
            raise ValueError('EasyScholar SecretKey 无效，请在设置中检查')
        raise ValueError('EasyScholar 查询失败，请检查调用额度或稍后重试')
    data = payload.get('data')
    if not isinstance(data, dict):
        raise ValueError('EasyScholar 返回数据不完整，请稍后重试')
    official_container = data.get('officialRank') or {}
    if not isinstance(official_container, dict):
        raise ValueError('EasyScholar 返回数据格式异常')
    official = official_container.get('all') or {}
    if not isinstance(official, dict):
        raise ValueError('EasyScholar 返回数据格式异常')
    metrics = [dict(key=k, label=label, value=official[k]) for k, label in LABELS.items() if k in official]
    custom = data.get('customRank') or {}
    if not isinstance(custom, dict) or not isinstance(custom.get('rankInfo', []), list) or not isinstance(custom.get('rank', []), list):
        raise ValueError('EasyScholar 返回数据格式异常')
    info = {str(x.get('uuid')): x for x in custom.get('rankInfo', []) if isinstance(x, dict)}
    for rank in custom.get('rank', []):
        parts = str(rank).split('&&&')
        if len(parts) != 2 or parts[1] not in ('1', '2', '3', '4', '5'):
            continue
        entry = info.get(parts[0], {})
        field = ('oneRankText', 'twoRankText', 'threeRankText', 'fourRankText', 'fiveRankText')[int(parts[1])-1]
        if entry.get('abbName') and entry.get(field):
            metrics.append(dict(key='custom:'+parts[0], label=entry['abbName'], value=entry[field]))
    return clean_rank(dict(source='easyScholar', publication=name, queried_at=now_iso(), metrics=metrics))


class Scholar:
    def __init__(self, home: Path, lib):
        self.home, self.lib = Path(home), lib
        self.cfg_path = self.home / 'easyscholar-config.json'
        self.key_path = self.home / '.easyscholar-key.bin'
        self.cache_path = self.home / '.easyscholar-cache.json'
        self.cfg = read_json(self.cfg_path, {}) or {}
        self.cache = read_json(self.cache_path, {}) or {}
        if not isinstance(self.cfg, dict):
            self.cfg = {}
        if not isinstance(self.cache, dict):
            self.cache = {}
        self.request_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.busy, self.message, self.error = False, '', ''
        self.last_request = 0.0
        self.retry_after = 0.0

    def _key(self):
        if not self.key_path.exists():
            raise ValueError('请先在「设置 → 期刊分区」保存 EasyScholar SecretKey')
        try:
            raw = self.key_path.read_bytes()
            if os.name == 'nt':
                from .drive import _protect
                raw = _protect(raw, decrypt=True)
            return raw.decode('utf-8')
        except Exception:
            raise ValueError('无法读取本机 EasyScholar 密钥，请重新保存') from None

    def configure(self, data):
        if not isinstance(data, dict):
            raise ValueError('配置必须是对象')
        if self.busy:
            raise ValueError('请等分区查询结束后再修改密钥')
        with self.request_lock:
            if self.busy:
                raise ValueError('请等分区查询结束后再修改密钥')
            key = str(data.get('secret_key') or '').strip()
            if key:
                if len(key) > 1024 or any(c.isspace() for c in key):
                    raise ValueError('SecretKey 格式不正确')
                raw = key.encode('utf-8')
                if os.name == 'nt':
                    from .drive import _protect
                    raw = _protect(raw)
                self.home.mkdir(parents=True, exist_ok=True)
                temp = self.key_path.with_suffix('.tmp')
                temp.write_bytes(raw)
                temp.chmod(0o600)
                os.replace(temp, self.key_path)
            if data.get('clear_key'):
                self.key_path.unlink(missing_ok=True)
            self.cfg = dict(auto_lookup=bool(data.get('auto_lookup', self.cfg.get('auto_lookup', False))))
            write_json_atomic(self.cfg_path, self.cfg)
            self.retry_after = 0
            self.error = ''
        return self.status()

    def status(self):
        return dict(configured=self.key_path.exists(), auto_lookup=bool(self.cfg.get('auto_lookup')),
                    busy=self.busy, message=self.message, error=self.error)

    def _fetch(self, key, name):
        url = API+'?'+urllib.parse.urlencode({'secretKey': key, 'publicationName': name})
        try:
            request = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'FolioRead/1.0'})
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read(256*1024+1)
                if len(raw) > 256*1024:
                    raise ValueError('EasyScholar 返回数据过大')
            payload = json.loads(raw)
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise ValueError('EasyScholar 调用频率或额度受限，请稍后重试') from None
            raise ValueError('EasyScholar 服务暂时不可用，请稍后重试') from None
        except (OSError, ValueError):
            raise ValueError('无法读取 EasyScholar 返回数据，请检查网络后重试') from None
        try:
            result = parse_result(payload, name)
        except (AttributeError, TypeError, KeyError):
            raise ValueError('EasyScholar 返回数据格式异常') from None
        if key in json.dumps(result, ensure_ascii=False):
            raise ValueError('EasyScholar 返回数据异常，未保存查询结果')
        return result

    def query(self, name, force=False):
        name = publication_name(name)
        if not queryable(name):
            raise ValueError('请填写正式期刊或会议全称；预印本平台没有期刊分区')
        with self.request_lock:
            key = self._key()
            ck = hashlib.sha256((key+'\0'+name.casefold()).encode()).hexdigest()
            result = clean_rank(self.cache.get(ck))
            if result and not force:
                fetched = datetime.fromisoformat(result['queried_at'].replace('Z', '+00:00')) if result['queried_at'] else None
                if fetched and fetched.tzinfo is None:
                    fetched = fetched.replace(tzinfo=timezone.utc)
                age = (datetime.now(timezone.utc)-fetched).total_seconds() if fetched else float('inf')
                if 0 <= age < (30 if result['status']=='found' else 1)*86400:
                    return result
            time.sleep(max(0, .6-(time.monotonic()-self.last_request)))
            self.last_request = time.monotonic()
            result = self._fetch(key, name)
            self.cache[ck] = result
            if len(self.cache) > 1000:
                self.cache = dict(list(self.cache.items())[-1000:])
            write_json_atomic(self.cache_path, self.cache)
            return result

    def lookup(self, ws, name=None, force=False):
        paper, item = ws.load('paper') or {}, ws.load('item') or {}
        meta = dict(paper.get('meta') or {}, **{k:v for k,v in (item.get('meta_override') or {}).items() if v})
        publication = publication_name(name if name is not None else meta.get('venue'))
        result = self.query(publication, force)
        if name is not None:
            ws.update('item', lambda i: i.setdefault('meta_override', {}).update(venue=publication))
        ws.update('paper', lambda p: p.setdefault('meta', {}).update(journal_rank=result))
        return result

    def refresh(self, force=False, automatic=False):
        if automatic and (not self.cfg.get('auto_lookup') or not self.key_path.exists() or time.monotonic() < self.retry_after):
            return
        if not automatic:
            self._key()
        with self.state_lock:
            if self.busy:
                return
            self.busy, self.error, self.message = True, '', '正在查询期刊分区…'
        def work():
            updated, skipped, results = 0, 0, {}
            try:
                for ws in self.lib.all():
                    paper, item = ws.load('paper') or {}, ws.load('item') or {}
                    meta = dict(paper.get('meta') or {}, **{k:v for k,v in (item.get('meta_override') or {}).items() if v})
                    name = publication_name(meta.get('venue'))
                    if not queryable(name):
                        skipped += 1
                        continue
                    ck = name.casefold()
                    if ck not in results:
                        results[ck] = self.query(name, force)
                    result = results[ck]
                    if visible_rank(meta) != result:
                        try:
                            with self.lib.activity(ws.id) as current:
                                current.update('paper', lambda p: p.setdefault('meta', {}).update(journal_rank=result))
                        except KeyError:
                            continue
                        updated += 1
                self.message = f'分区查询完成：更新 {updated} 篇，跳过 {skipped} 篇未填写期刊或预印本'
            except ValueError as exc:
                self.error = str(exc)
                self.message = f'查询已暂停，已保存 {updated} 篇结果'
                self.retry_after = time.monotonic()+300
            except Exception:
                self.error = '本机分区结果保存失败，请检查资料目录后重试'
                self.retry_after = time.monotonic()+300
            finally:
                self.busy = False
        threading.Thread(target=work, daemon=True, name='FolioJournalRanks').start()
