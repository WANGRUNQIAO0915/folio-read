"""Preserve real PDF web destinations without modifying the reader's text."""
from __future__ import annotations

import logging
import re
from pathlib import Path
from urllib.parse import urlsplit

from .store import dir_lock, read_json, write_json_atomic

log = logging.getLogger(__name__)


def safe_url(value) -> str:
    if not isinstance(value, str) or len(value) > 4096:
        return ''
    value = value.strip()
    if re.search(r'[\s\\\x00-\x1f\x7f]', value):
        return ''
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() in ('http', 'https') and parsed.hostname and not parsed.username:
            return value
        if parsed.scheme.lower() == 'mailto' and '@' in parsed.path:
            return value
    except ValueError:
        pass
    return ''


def ensure(root: Path) -> list[dict]:
    """Cache annotation URLs separately; old translations need no retranslation."""
    import pdfplumber

    pdf = root / 'source.pdf'
    if not pdf.is_file():
        return []
    cache_path = root / 'extract' / 'links.json'
    with dir_lock(root):
        stat = pdf.stat()
        fingerprint = [stat.st_size, stat.st_mtime_ns]
        cached = read_json(cache_path, {})
        if cached.get('version') == 1 and cached.get('source') == fingerprint:
            return cached.get('links', [])
        links, seen = [], set()
        try:
            with pdfplumber.open(pdf) as doc:
                for n, page in enumerate(doc.pages, 1):
                    for annotation in page.hyperlinks:
                        uri = safe_url(annotation.get('uri'))
                        if not uri:
                            continue
                        x0, top, x1, bottom = (float(annotation[k]) for k in ('x0', 'top', 'x1', 'bottom'))
                        selected = [c for c in page.chars if
                                    x0 <= (c['x0'] + c['x1']) / 2 <= x1 and
                                    top <= (c['top'] + c['bottom']) / 2 <= bottom]
                        label = (pdfplumber.utils.extract_text(selected, x_tolerance=2, y_tolerance=3) or '').strip()
                        if not re.search(r'[\w\u4e00-\u9fff]{2}', label):
                            label = ''
                        key = (n, uri, label)
                        if key in seen:
                            continue
                        seen.add(key)
                        links.append({'page': n, 'url': uri, 'label': label,
                                      'box': [round(x0 / page.width, 4), round(top / page.height, 4),
                                              round(x1 / page.width, 4), round(bottom / page.height, 4)]})
        except Exception:
            log.warning('无法读取原文网页链接：%s', pdf.name, exc_info=True)
            return []
        cache_path.parent.mkdir(exist_ok=True)
        write_json_atomic(cache_path, {'version': 1, 'source': fingerprint, 'links': links})
        return links


def _norm(text: str) -> str:
    return ''.join(re.findall(r'\w', text.casefold()))


def for_reader(ws, paper: dict | None = None) -> dict:
    """Attach only unambiguous source links; the cached paper itself is unchanged."""
    from .pdfwork import block_english

    paper = dict(paper if paper is not None else ws.load('paper'))
    source_links = ensure(ws.root)
    paper['source_links'] = source_links
    blocks = [dict(b) for b in paper.get('blocks', [])]
    for b in blocks:
        b.pop('source_links', None)
        b.pop('source_link_only', None)
    for link in source_links:
        label = _norm(link['label'])
        if len(label) < 5:
            continue
        candidates = [b for b in blocks if b.get('page') == link['page'] and
                      label in _norm(block_english(b))]
        # Don't guess which repeated phrase a PDF annotation belongs to.
        if len(candidates) != 1:
            continue
        block = candidates[0]
        destinations = block.setdefault('source_links', [])
        if not any((item['url'], item['label']) == (link['url'], link['label']) for item in destinations):
            destinations.append(link)
        if block.get('type') in ('para', 'heading', 'note') and label == _norm(block_english(block)):
            block['source_link_only'] = link['url']
    for block in blocks:
        if len({link['url'] for link in block.get('source_links', [])}) > 1:
            block.pop('source_link_only', None)
    paper['blocks'] = blocks
    return paper
