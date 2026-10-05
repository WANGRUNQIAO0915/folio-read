"""Validate a browser download before importing its original PDF bytes.

This is a conservative structural/active-content check, not antivirus scanning
or a sandbox. It never receives browser URLs, cookies, headers or credentials.
The caller owns the temporary download and must remove it when finished.
"""
from __future__ import annotations

import io
import math
import os
import re
import stat
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, StreamObject

from .library import Library
from .organization import Organization

MAX_PDF_BYTES = 100 * 1024 * 1024
MAX_PDF_PAGES = 3000
_MAX_OBJECTS = 250_000
_MAX_DEPTH = 128
_INVALID = '下载的文件不是完整有效的 PDF，请在机构页面重新下载'
_ACTIVE = 'PDF 含脚本、主动操作或附件，无法通过机构导入；请使用不含这些内容的 PDF'
_COMPLEX = 'PDF 结构过于复杂，无法安全检查，请换用普通 PDF'
_BLOCKED_KEYS = frozenset({
    '/AA', '/JS', '/JavaScript', '/EmbeddedFiles', '/EF', '/AF', '/Collection',
    '/XFA', '/RichMediaContent', '/RichMediaSettings', '/OPI',
})
_BLOCKED_ACTIONS = frozenset({
    '/JavaScript', '/Launch', '/GoToR', '/GoToE', '/SubmitForm', '/ImportData',
    '/ResetForm', '/Rendition', '/Movie', '/Sound', '/Thread', '/Hide', '/Named',
    '/SetOCGState', '/Trans', '/GoTo3DView',
})
_BLOCKED_ANNOTATIONS = frozenset({'/FileAttachment', '/RichMedia', '/Movie', '/Sound', '/Screen', '/3D'})


def download_filename(filename: str | None) -> str:
    """Keep a display filename only, never a path, URL query or fragment."""
    value = filename if isinstance(filename, str) else ''
    if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://', value):
        try:
            value = urlsplit(value).path
        except ValueError:
            value = ''
    value = re.split(r'[?#]', value, maxsplit=1)[0]
    value = value.replace('\\', '/').rsplit('/', 1)[-1]
    value = ''.join(c for c in value if not unicodedata.category(c).startswith('C'))
    value = re.sub(r'[<>:"|*]', '_', value).strip(' .')
    if not value or value.lower() in {'pdf', '.pdf'}:
        return 'paper.pdf'
    if value.lower().endswith('.pdf'):
        value = value[:-4]
    return value[:200].rstrip(' .') + '.pdf'


def _resolve(value):
    """Reject cyclic indirect-reference chains before following them."""
    seen = set()
    while isinstance(value, IndirectObject):
        key = (value.idnum, value.generation)
        if key in seen or len(seen) >= _MAX_DEPTH:
            raise ValueError(_INVALID)
        seen.add(key)
        value = value.get_object()
    return value


def _check_action(value, automatic=False):
    action = _resolve(value)
    # A document open destination only chooses a page/zoom; it cannot execute.
    if automatic and isinstance(action, ArrayObject):
        return
    if not isinstance(action, DictionaryObject):
        raise ValueError(_ACTIVE)
    kind = _resolve(action.get('/S'))
    if kind not in ('/GoTo', '/URI') or (automatic and (kind != '/GoTo' or '/Next' in action)):
        raise ValueError(_ACTIVE)
    if kind == '/URI':
        uri = _resolve(action.get('/URI'))
        if not isinstance(uri, str) or any(ord(c) < 32 or ord(c) == 127 for c in uri):
            raise ValueError(_ACTIVE)
        parsed = urlsplit(uri)
        if parsed.scheme.lower() not in ('http', 'https', 'mailto'):
            raise ValueError(_ACTIVE)
        if parsed.scheme.lower() in ('http', 'https') and not parsed.hostname:
            raise ValueError(_ACTIVE)


def _check_objects(reader):
    """Inspect decoded PDF dictionaries, including indirect and compressed ones.

    Do not search raw bytes: PDF names can be escaped and harmless page text can
    contain words such as JavaScript. Stream bodies are not executed or rendered.
    """
    pending = [(reader.trailer, 0)]
    # Inspect orphan objects too because we preserve the original file verbatim.
    for generation, entries in reader.xref.items():
        if generation != 65535:
            pending.extend((IndirectObject(number, generation, reader), 0) for number in entries if number)
    pending.extend((IndirectObject(number, 0, reader), 0) for number in reader.xref_objStm)
    if len(pending) > _MAX_OBJECTS:
        raise ValueError(_COMPLEX)
    references, containers, visited = set(), set(), 0
    while pending:
        value, depth = pending.pop()
        visited += 1
        if depth > _MAX_DEPTH or visited > _MAX_OBJECTS:
            raise ValueError(_COMPLEX)
        if isinstance(value, IndirectObject):
            key = (value.idnum, value.generation)
            if key in references:
                continue
            references.add(key)
            value = _resolve(value)
        if isinstance(value, (DictionaryObject, ArrayObject)):
            if id(value) in containers:
                continue
            containers.add(id(value))
        if isinstance(value, DictionaryObject):
            if _BLOCKED_KEYS.intersection(value):
                raise ValueError(_ACTIVE)
            if _resolve(value.get('/S')) in _BLOCKED_ACTIONS:
                raise ValueError(_ACTIVE)
            if _resolve(value.get('/Type')) in ('/EmbeddedFile', '/RichMedia'):
                raise ValueError(_ACTIVE)
            if _resolve(value.get('/Subtype')) in _BLOCKED_ANNOTATIONS:
                raise ValueError(_ACTIVE)
            # External-file streams/reference XObjects may load other content.
            if isinstance(value, StreamObject) and any(k in value for k in ('/F', '/FFilter', '/FDecodeParms', '/Ref')):
                raise ValueError(_ACTIVE)
            if '/OpenAction' in value:
                _check_action(value['/OpenAction'], automatic=True)
            if _resolve(value.get('/Type')) == '/Action' or _resolve(value.get('/S')) in ('/GoTo', '/URI'):
                _check_action(value)
            if '/A' in value and _resolve(value.get('/Subtype')) == '/Link':
                _check_action(value['/A'])
            pending.extend((child, depth + 1) for child in value.values())
        elif isinstance(value, ArrayObject):
            pending.extend((child, depth + 1) for child in value)
        if len(pending) > _MAX_OBJECTS:
            raise ValueError(_COMPLEX)


def _check_pages(reader):
    """Bound and check the page tree before pypdf's recursive flattening."""
    root = _resolve(reader.trailer.get('/Root'))
    if not isinstance(root, DictionaryObject) or _resolve(root.get('/Type')) != '/Catalog':
        raise ValueError(_INVALID)
    pages = _resolve(root.get('/Pages'))
    pending, seen, count = [(pages, 0, False)], set(), 0
    totals = {}
    while pending:
        node, depth, exiting = pending.pop()
        node = _resolve(node)
        if not isinstance(node, DictionaryObject) or depth > _MAX_DEPTH:
            raise ValueError(_INVALID)
        if exiting:
            children = _resolve(node.get('/Kids'))
            total = sum(totals[id(_resolve(child))] for child in children)
            if _resolve(node.get('/Count')) != total:
                raise ValueError(_INVALID)
            totals[id(node)] = total
            continue
        if id(node) in seen:
            raise ValueError(_INVALID)
        seen.add(id(node))
        kind = _resolve(node.get('/Type'))
        if kind == '/Pages':
            declared = _resolve(node.get('/Count'))
            if not isinstance(declared, int) or declared < 0:
                raise ValueError(_INVALID)
            if declared > MAX_PDF_PAGES:
                raise ValueError(f'机构导入最多支持 {MAX_PDF_PAGES} 页 PDF')
            children = _resolve(node.get('/Kids'))
            if not isinstance(children, ArrayObject) or not children:
                raise ValueError(_INVALID)
            pending.append((node, depth, True))
            pending.extend((child, depth + 1, False) for child in children)
        elif kind == '/Page':
            count += 1
            if count > MAX_PDF_PAGES:
                raise ValueError(f'机构导入最多支持 {MAX_PDF_PAGES} 页 PDF')
            totals[id(node)] = 1
        else:
            raise ValueError(_INVALID)
    if not count or len(reader.pages) != count:
        raise ValueError(_INVALID)
    for page in reader.pages:
        box = page.mediabox
        if len(box) != 4 or not all(math.isfinite(float(n)) for n in box) or box.width <= 0 or box.height <= 0:
            raise ValueError(_INVALID)


def validate_pdf(path: str | Path) -> bytes:
    """Return original validated bytes, or raise a safe, user-facing ValueError.

    File size is checked before allocating the body, and the read itself is
    bounded to handle a file that grows after the stat. Never accept encryption,
    even when an empty password would let a PDF parser silently unlock it.
    """
    try:
        path = Path(path)
        if path.is_symlink():
            raise ValueError('下载文件路径无效，请重新下载 PDF')
        flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
        with os.fdopen(os.open(path, flags), 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('下载文件路径无效，请重新下载 PDF')
            if info.st_size > MAX_PDF_BYTES:
                raise ValueError('机构导入的 PDF 不能超过 100 MiB')
            data = stream.read(MAX_PDF_BYTES + 1)
    except OSError:
        raise ValueError('无法读取已下载 PDF，请重新下载') from None
    if len(data) > MAX_PDF_BYTES:
        raise ValueError('机构导入的 PDF 不能超过 100 MiB')
    if not re.match(rb'%PDF-(?:1\.[0-7]|2\.0)(?:[\r\n \t])', data) or not data.rstrip(b'\x00\t\n\r\f ').endswith(b'%%EOF'):
        raise ValueError(_INVALID)
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ValueError('不支持加密或密码保护的 PDF，请先取得可直接阅读的版本')
        _check_objects(reader)
        _check_pages(reader)
    except ValueError as error:
        # Preserve only our controlled messages, never parser data or paths.
        if str(error) in (_INVALID, _ACTIVE, _COMPLEX) or str(error).startswith(('机构导入最多支持 ', '不支持加密或密码保护')):
            raise
        raise ValueError(_INVALID) from None
    except Exception:
        raise ValueError(_INVALID) from None
    return data


def import_download(path: str | Path, filename: str, library: Library, folder_id=None) -> dict:
    """Validate, deduplicate and import; retain an existing paper's classification.

    Lifecycle and organization locks cover folder validation and assignment. A
    duplicate is never reassigned, even if the user selected a different folder.
    This function does not enqueue rendering, translation, AI or network work.
    """
    data = validate_pdf(path)
    ws, fresh = Organization(library).import_pdf(data, download_filename(filename), folder_id)
    return {'id': ws.id, 'fresh': fresh, 'message': 'PDF 已导入资料库' if fresh else '资料库已有相同 PDF，已保留原有分类和笔记'}
