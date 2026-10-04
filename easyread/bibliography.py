"""Exact-DOI bibliographic records for standard citation output; no AI guesses."""
from __future__ import annotations

import copy
import difflib
import html
import json
import re
import urllib.parse
import urllib.request

from .store import read_json, write_json_atomic


def text(value):
    return html.unescape(re.sub(r'<[^>]*>', '', str(value or ''))).strip()[:4000]


def doi(value):
    value = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', text(value), flags=re.I).strip()
    return value if re.fullmatch(r'10\.\d{4,9}/[^\s<>"{}]+', value, re.I) else ''


def clean(value):
    out = {}
    for key in ('type', 'title', 'container-title', 'volume', 'issue', 'page', 'number', 'DOI', 'URL', 'publisher', 'publisher-place', 'archive', 'archive_location', 'genre', 'language'):
        if value.get(key):
            out[key] = text(value[key])
    for key in ('author', 'editor'):
        out[key] = [{k: text(n[k]) for k in ('family', 'given', 'literal', 'suffix', 'non-dropping-particle', 'dropping-particle') if n.get(k)}
                    for n in value.get(key, [])[:500] if isinstance(n, dict) and (n.get('family') or n.get('literal'))] if isinstance(value.get(key, []), list) else []
    parts = (value.get('issued') or {}).get('date-parts', []) if isinstance(value.get('issued'), dict) else []
    if parts and isinstance(parts[0], list) and parts[0] and all(isinstance(n, int) and 0 < n < 10000 for n in parts[0][:3]):
        out['issued'] = {'date-parts': [parts[0][:3]]}
    return out


def fallback(meta):
    arxiv = text(meta.get('arxiv')).removeprefix('arXiv:')
    out = clean({'type': meta.get('citation_type') or ('article' if arxiv and not meta.get('venue') else 'article-journal'),
                 'title': meta.get('title_en') or meta.get('title_zh'), 'container-title': meta.get('venue'),
                 'volume': meta.get('volume'), 'issue': meta.get('issue'), 'page': meta.get('citation_pages') or meta.get('page_range'),
                 'number': meta.get('article_number'), 'DOI': doi(meta.get('doi')), 'URL': meta.get('url'),
                 'author': meta.get('authors_structured') or meta.get('author') or []})
    if not out['author'] and meta.get('authors'):
        # Legacy strings are ambiguous ("Smith, John" versus two authors). Preserve
        # literal names rather than manufacture surnames/initials from commas.
        out['author'] = [{'literal': n.strip()} for n in re.split(r';|；|\s+and\s+', text(meta['authors'])) if n.strip()]
    year = re.search(r'\b(?:19|20)\d{2}\b', str(meta.get('year') or meta.get('date') or ''))
    if year:
        out['issued'] = {'date-parts': [[int(year[0])]]}
    if arxiv and out['type'] == 'article':
        out.update(archive='arXiv', archive_location=arxiv, genre='Preprint', URL='https://arxiv.org/abs/' + arxiv)
    return out


def fetch_doi(identifier):
    url = 'https://api.crossref.org/works/' + urllib.parse.quote(identifier, safe='') + '/transform/application/vnd.citationstyles.csl+json'
    req = urllib.request.Request(url, headers={'User-Agent': 'FolioRead/1.1 (bibliographic metadata)', 'Accept': 'application/vnd.citationstyles.csl+json'})
    with urllib.request.urlopen(req, timeout=12) as response:
        raw = response.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('书目响应过大')
    record = clean(json.loads(raw))
    if doi(record.get('DOI')).lower() != identifier.lower() or not record.get('title'):
        raise ValueError('DOI 书目不匹配')
    return record


def citation(ws):
    meta = copy.deepcopy((ws.load('paper') or {}).get('meta') or {})
    overrides = (ws.load('item') or {}).get('meta_override') or {}
    meta.update({k: v for k, v in overrides.items() if v})
    identifier = doi(meta.get('doi'))
    out, source, warnings = fallback(meta), '本机元数据', []
    cache_path = ws.root / 'citation.json'
    cache = read_json(cache_path, {}) or {}
    if identifier:
        record = cache.get('record') if cache.get('doi', '').lower() == identifier.lower() else None
        if not record:
            try:
                record = fetch_doi(identifier)
                write_json_atomic(cache_path, {'doi': identifier, 'record': record})
            except (ValueError, OSError, TimeoutError, json.JSONDecodeError):
                warnings.append('DOI 书目暂时无法获取，使用本机资料；可稍后再试。')
        if record:
            out, source = clean(record), 'Crossref · DOI 核对'
            original = re.sub(r'\W+', '', text(meta.get('title_en')).lower())
            published = re.sub(r'\W+', '', out.get('title', '').lower())
            if original and difflib.SequenceMatcher(None, original, published).ratio() < .7:
                warnings.append('DOI 对应题名与本机原标题不同，请核对 DOI 后再使用此引用。')
    # Explicit manual metadata always wins over cached bibliographic fields.
    mapping = {'title_en': 'title', 'authors': 'author', 'venue': 'container-title', 'volume': 'volume', 'issue': 'issue', 'citation_pages': 'page', 'article_number': 'number', 'year': 'issued', 'url': 'URL'}
    override_record = fallback({**meta, **overrides})
    for local, csl in mapping.items():
        if overrides.get(local) and override_record.get(csl):
            out[csl] = override_record[csl]
    out['id'] = ws.id
    missing = [label for key, label in [('title', '题名'), ('author', '作者'), ('issued', '年份')] if not out.get(key)]
    if out.get('type') == 'article-journal':
        missing += [label for key, label in [('container-title', '期刊'), ('volume', '卷号')] if not out.get(key)]
        if not out.get('page') and not out.get('number'):
            missing.append('页码或文章号')
    if (source == '本机元数据' or overrides.get('authors')) and meta.get('authors') and not meta.get('authors_structured'):
        warnings.append('作者仅有文本记录，未拆分姓名；请核对作者顺序和姓名格式。')
    if missing:
        warnings.append('缺少' + '、'.join(missing) + '，引用需补齐。')
    return {'item': out, 'source': source, 'warnings': warnings}
