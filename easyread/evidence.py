"""Paper passages and verifiable citation snapshots used by the study workbench."""
from __future__ import annotations

import hashlib
import math
import re
from urllib.parse import quote


def block_text(block: dict, language: str = 'en') -> str:
    if block.get('type') == 'math':
        return block.get('tex') or ''
    if block.get('type') == 'list':
        return '\n'.join(str(x.get(language) or '') for x in block.get('items', []))
    if block.get('type') in ('figure', 'table'):
        text = str(block.get('caption_' + language) or '')
        if block.get('type') == 'table':
            text += '\n' + '\n'.join(' | '.join(map(str, row)) for row in block.get('head', []) + block.get('rows', []))
        return text
    return str(block.get(language) or '')


def compact(text: str) -> str:
    return re.sub(r'\s+', '', str(text)).casefold()


def tokens(text: str) -> set[str]:
    text = text.casefold()
    out = set(re.findall(r'[a-z][a-z0-9_-]{1,}|\d+(?:\.\d+)?', text))
    for run in re.findall(r'[\u3400-\u9fff]+', text):
        out.update(run[i:i + 2] for i in range(len(run) - 1))
    return out - {'the', 'and', 'with', 'that', 'this', 'from', 'what', 'why', 'how', '论文', '作者', '什么', '如何'}


def passages(ws) -> list[dict]:
    paper = ws.load('paper') or {}
    meta = paper.get('meta', {})
    title = meta.get('title_zh') or meta.get('title_en') or ws.id
    out, represented, section = [], set(), ''
    ancestors = {}
    done = set((paper.get('translation') or {}).get('done_pages', []))
    for block in paper.get('blocks', []):
        if block.get('type') in ('note', 'references'):
            continue  # AI discussion is never treated as paper evidence.
        if block.get('type') == 'heading':
            section = block.get('id', '')
            level = int(block.get('level') or 1)
            ancestors = {k: v for k, v in ancestors.items() if k < level}
            ancestors[level] = section
        en, zh = block_text(block), block_text(block, 'zh')
        if not (en.strip() or zh.strip()):
            continue
        page = block.get('page')
        represented.add(page)
        # Long blocks are split rather than silently losing their tail.
        primary = en or zh
        for offset in range(0, len(primary), 2400):
            chunk = primary[offset:offset + 2400]
            out.append({'paper': ws.id, 'title': title, 'anchor': block['id'], 'page': page,
                        'section': section, 'section_path': list(ancestors.values()), 'type': block.get('type'),
                        'role': block.get('role', ''), 'level': block.get('level', 0), 'appendix': bool(block.get('appendix')),
                        'en': chunk if en else '',
                        'zh': zh[:2400] if en else chunk, 'original': bool(en),
                        'url': '/read/' + quote(ws.id) + '#b-' + quote(block['id']),
                        'fingerprint': hashlib.sha256((en + '\n' + zh).encode()).hexdigest()[:16]})
    # Untranslated pages can still be read and queried after PDF preparation.
    for path in sorted((ws.root / 'extract').glob('page-*.txt')):
        match = re.fullmatch(r'page-(\d+)\.txt', path.name)
        if not match or (int(match[1]) in represented and int(match[1]) in done):
            continue
        page = int(match[1])
        text = path.read_text(encoding='utf-8', errors='replace')
        for offset in range(0, len(text), 2400):
            chunk = text[offset:offset + 2400].strip()
            if chunk:
                out.append({'paper': ws.id, 'title': title, 'anchor': '', 'page': page, 'section': '',
                            'type': 'raw', 'en': chunk, 'zh': '', 'original': True,
                            'url': '/read/' + quote(ws.id) + '?source_page=' + str(page),
                            'fingerprint': hashlib.sha256(text.encode()).hexdigest()[:16]})
    return out


EXPANSIONS = {'方法': 'method approach algorithm', '数据': 'dataset data sample', '实验': 'experiment evaluation',
              '结果': 'results performance accuracy', '局限': 'limitations assumptions', '验证': 'validation baseline evaluation',
              '假设': 'assumption theorem', '奖励': 'reward', '泛化': 'generalization distribution', '公式': 'equation proof',
              '优化': 'optimization objective loss', '训练': 'training learning', '边界': 'limitations domain distribution', '指标': 'metric evaluation'}


def select(all_sources: list[dict], query: str, mode: str, section: str = '', asset: str = '', budget: int = 26000) -> list[dict]:
    candidates = [s for s in all_sources if not section or section in s.get('section_path', [s['section']])]
    if not candidates:
        return []
    expanded = query + ' ' + ' '.join(v for k, v in EXPANSIONS.items() if k in query)
    words = tokens(expanded)
    bags = [tokens(s['en'] + ' ' + s['zh']) for s in candidates]
    df = {w: sum(w in bag for bag in bags) for w in words}
    scores = [sum(math.log(1 + len(bags) / (1 + df[w])) for w in words & bag) for bag in bags]
    prioritized = []
    if asset:
        positions = [i for i, s in enumerate(candidates) if s['anchor'] == asset]
        for pos in positions:
            prioritized += list(range(max(0, pos - 3), min(len(candidates), pos + 4)))
        btype = next((s['type'] for s in candidates if s['anchor'] == asset), '')
        # Retrieve paragraphs referring to the figure/table/equation as well as neighbours.
        scores = [score + (8 if s['anchor'] == asset else 0) for score, s in zip(scores, candidates)]
        if not btype:
            raise ValueError('找不到所选图表或公式')
    if mode in ('overview', 'compare'):
        # An overview needs the abstract and actual argument, not just headings.
        prioritized += [i for i, s in enumerate(candidates) if s.get('role') == 'abstract']
        prioritized += list(range(min(4, len(candidates))))
        mains = [i for i, s in enumerate(candidates) if s['type'] == 'heading' and
                 int(s.get('level') or 1) == 1 and not s.get('appendix')]
        prioritized += mains
        for index in mains:
            following = next((i for i in range(index + 1, min(index + 6, len(candidates)))
                              if candidates[i]['type'] != 'heading'), None)
            if following is not None:
                prioritized.append(following)
        prioritized += [0, len(candidates) - 1]
        prioritized += [round(i * (len(candidates) - 1) / 11) for i in range(12)]
    ranked = sorted(range(len(candidates)), key=lambda i: scores[i], reverse=True)
    if not any(scores) and not prioritized:
        prioritized += [round(i * (len(candidates) - 1) / 11) for i in range(12)]
    prioritized += ranked
    chosen, used, seen = [], 0, set()
    for index in prioritized:
        if index in seen:
            continue
        seen.add(index)
        source = candidates[index]
        size = len(source['en']) + len(source['zh']) + 120
        if used + size > budget:
            continue
        chosen.append((index, source))
        used += size
        if len(chosen) >= 42:
            break
    return [s for _, s in sorted(chosen)]


def numbered(sources: list[dict]) -> list[dict]:
    return [{**s, 'id': 'E' + str(i + 1)} for i, s in enumerate(sources)]


def verify_claim(claim: dict, sources: list[dict], paper: str | None = None) -> dict:
    if not isinstance(claim, dict) or not str(claim.get('text') or '').strip():
        raise ValueError('模型返回了空结论')
    kind = claim.get('kind', 'uncertain')
    if kind not in ('source', 'interpretation', 'uncertain'):
        kind = 'uncertain'
    by_id = {s['id']: s for s in sources}
    citations, warnings = [], []
    for cit in (claim.get('citations') or [])[:12]:
        if not isinstance(cit, dict):
            continue
        src = by_id.get(cit.get('id'))
        quoted = str(cit.get('quote') or '').strip()[:1200]
        if not src or not quoted or (paper and src['paper'] != paper):
            warnings.append('来源编号无效或不属于本篇论文')
            continue
        needle = compact(quoted)
        if len(needle) < 4 or not any(needle in compact(src[field]) for field in ('en', 'zh')):
            warnings.append('引文无法在所提供段落中核对')
            continue
        origin = '原文' if src['en'] and needle in compact(src['en']) else '译文'
        if src['type'] in ('math', 'table'):
            origin = '重排公式' if src['type'] == 'math' else '重排表格'
        if src['type'] == 'reader_note':
            origin = '我的笔记'
        citations.append({k: src[k] for k in ('id', 'paper', 'title', 'anchor', 'page', 'url', 'fingerprint')} |
                         {'quote': quoted, 'origin': origin} |
                         ({'note_id': src['note_id']} if src['type'] == 'reader_note' else {}))
    if kind == 'source' and (not citations or warnings):
        kind = 'uncertain'
        warnings.append('原文依据未通过核对，暂作待核实内容')
    return {'text': str(claim['text']).strip()[:6000], 'kind': kind, 'citations': citations,
            'warnings': list(dict.fromkeys(warnings))}
