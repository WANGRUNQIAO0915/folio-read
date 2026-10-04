"""从各种来源拿到论文 PDF 和元数据。

能认的输入：
- arXiv 编号或链接（2411.00640、arxiv.org/abs/…）
- DOI（10.xxxx/…、doi.org 链接）——依次查开放全文、Crossref 和出版社页面
- OpenReview、ACL Anthology、bioRxiv / medRxiv、PubMed Central 链接
- 期刊 / 会议的论文页面——读页面里的 citation_pdf_url 等元数据（Google Scholar 和 Zotero 都认这套标签）
- PDF 直链
- 完整论文标题——在 Semantic Scholar、Crossref 和 arXiv 中核对标题

本地拖进来的 PDF 也会用这里的 enrich()：从第一页找 arXiv 编号或 DOI，补上作者、年份、出处。
"""
from __future__ import annotations

import html
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 FolioRead"
MAX_PDF = 200 * 1024 * 1024
S2 = "https://api.semanticscholar.org/graph/v1/paper/"
S2_FIELDS = "title,authors,year,venue,publicationDate,externalIds,openAccessPdf,abstract,url"

ARXIV_RE = re.compile(r"(?<![\d.])(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)(?![\d])", re.I)
DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+[^\s\"<>.,;)\]])", re.I)


class SourceError(ValueError):
    def __init__(self, message: str, code: str = "unavailable"):
        super().__init__(message)
        self.code = code


# ---------- 网络 ----------
def _get(url: str, accept: str = "*/*", timeout: int = 60, limit: int = MAX_PDF) -> tuple[bytes, str, str]:
    """返回 (内容, Content-Type, 最终地址)。"""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise SourceError("请使用有效的 HTTP 或 HTTPS 论文地址", "invalid_input")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en,zh;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read(limit + 1)
            ctype, final = r.headers.get("Content-Type", ""), r.geturl()
    except urllib.error.HTTPError as e:
        code, detail = {
            404: ("not_found", "地址不存在（404）"),
            401: ("access_denied", "需要登录或访问授权（401）"),
            403: ("access_denied", "网站拒绝自动访问，可能需要浏览器登录（403）"),
            429: ("rate_limited", "请求受到限流，请稍后重试（429）"),
        }.get(e.code, ("service_unavailable", f"服务暂时不可用（{e.code}）"))
        raise SourceError(f"{parsed.hostname}：{detail}", code) from None
    except (OSError, TimeoutError):
        raise SourceError(f"无法连接 {parsed.hostname}，请检查网络、代理和 HTTPS 连接后重试", "network") from None
    if len(data) > limit:
        raise SourceError("下载内容超过大小限制；PDF 最多支持 200 MB", "too_large")
    return data, ctype, final


def _json(url: str) -> dict:
    data, _, _ = _get(url, "application/json", 30, 5_000_000)
    try:
        result = json.loads(data)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, UnicodeError):
        raise SourceError("检索服务没有返回有效的数据，请稍后重试", "invalid_response") from None


def _pdf(url: str) -> bytes:
    data, _, _ = _get(url, "application/pdf,*/*", 120)
    if not data.startswith(b"%PDF"):
        raise SourceError("下载地址返回了网页而非 PDF，可能需要登录或订阅", "access_denied")
    return data


def _name(url: str, fallback: str = "paper") -> str:
    name = re.sub(r"[?#&].*", "", urllib.parse.unquote(url.split("?")[0].rstrip("/").rsplit("/", 1)[-1])) or fallback
    name = re.sub(r"[^\w.\-]+", "_", name)[:80] or fallback
    return name if name.lower().endswith(".pdf") else name + ".pdf"


# ---------- 元数据 ----------
def arxiv_meta(aid: str) -> dict:
    meta = {"arxiv": f"arXiv:{aid}", "url": f"https://arxiv.org/abs/{aid}"}
    try:
        data, _, _ = _get(f"https://export.arxiv.org/api/query?id_list={aid}", timeout=30, limit=2_000_000)
        meta.update(_parse_arxiv_atom(data))
    except Exception:  # noqa: BLE001 —— 元数据拿不到不影响导入
        pass
    return meta


def _parse_arxiv_atom(xml: bytes) -> dict:
    ns = {"a": "http://www.w3.org/2005/Atom", "ax": "http://arxiv.org/schemas/atom"}
    entry = ET.fromstring(xml).find("a:entry", ns)
    if entry is None:
        return {}
    text = lambda tag: " ".join((entry.findtext(tag, "", ns) or "").split())  # noqa: E731
    authors = [" ".join((a.findtext("a:name", "", ns) or "").split()) for a in entry.findall("a:author", ns)]
    published = text("a:published")
    out = {"title_en": text("a:title"), "authors": ", ".join(authors), "abstract_en": text("a:summary"),
           "date": published[:10], "year": published[:4]}
    doi = text("ax:doi")
    if doi:
        out["doi"] = doi
    return {k: v for k, v in out.items() if v}


def _s2_meta(p: dict) -> dict:
    ext = _obj(p.get("externalIds"))
    meta = {
        "title_en": _text(p.get("title")),
        "authors": ", ".join(_text(a.get("name")) for a in _objects(p.get("authors"))),
        "year": str(p.get("year") or ""),
        "date": p.get("publicationDate") or "",
        "venue": p.get("venue") or "",
        "abstract_en": p.get("abstract") or "",
    }
    if ext.get("DOI"):
        meta["doi"] = ext["DOI"]
        meta["url"] = f"https://doi.org/{ext['DOI']}"
    if ext.get("ArXiv"):
        meta["arxiv"] = f"arXiv:{ext['ArXiv']}"
        meta.setdefault("url", f"https://arxiv.org/abs/{ext['ArXiv']}")
    meta.setdefault("url", p.get("url") or "")
    return {k: v for k, v in meta.items() if v}


def s2_lookup(key: str) -> dict | None:
    """key 形如 DOI:10.1/xx、ARXIV:2411.00640、PMCID:…、URL:…；找不到返回 None。"""
    try:
        return _json(S2 + urllib.parse.quote(key, safe=":/") + "?fields=" + S2_FIELDS)
    except Exception:  # noqa: BLE001
        return None


def s2_search_title(title: str) -> dict | None:
    try:
        d = _json(S2 + "search/match?query=" + urllib.parse.quote(title) + "&fields=" + S2_FIELDS)
        return (d.get("data") or [None])[0]
    except Exception:  # noqa: BLE001
        return None


# ---------- 网页里的 PDF 链接 ----------
_META_RE = re.compile(r"<meta\s+[^>]*?(?:name|property)\s*=\s*[\"']([^\"']+)[\"'][^>]*?content\s*=\s*[\"']([^\"']*)[\"']", re.I)
_META_RE2 = re.compile(r"<meta\s+[^>]*?content\s*=\s*[\"']([^\"']*)[\"'][^>]*?(?:name|property)\s*=\s*[\"']([^\"']+)[\"']", re.I)


def _page_meta(page: str) -> dict[str, list[str]]:
    tags: dict[str, list[str]] = {}
    for k, v in _META_RE.findall(page):
        tags.setdefault(k.lower(), []).append(html.unescape(v))
    for v, k in _META_RE2.findall(page):
        tags.setdefault(k.lower(), []).append(html.unescape(v))
    return tags


def _first_last(name: str) -> str:
    """“Vaswani, Ashish” → “Ashish Vaswani”。"""
    last, sep, first = name.partition(",")
    return f"{first.strip()} {last.strip()}" if sep and first.strip() else name.strip()


def _doi(value: str) -> str:
    value = urllib.parse.unquote(str(value or "")).strip()
    match = DOI_RE.search(value)
    return match.group(1).rstrip(".,; ") if match else ""


def _title_key(title: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", html.unescape(_text(title))).casefold() if c.isalnum())


def _obj(value) -> dict:
    return value if isinstance(value, dict) else {}


def _objects(value) -> list[dict]:
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def _text(value) -> str:
    return value if isinstance(value, str) else ""


def _first_text(value) -> str:
    return _text(value[0]) if isinstance(value, list) and value else _text(value)


def _crossref_meta(work: dict) -> dict:
    parts = []
    for key in ("published", "issued", "published-online", "published-print"):
        dates = _obj(work.get(key)).get("date-parts")
        if isinstance(dates, list) and dates and isinstance(dates[0], list):
            parts = dates[0][:3]
            if parts and all(isinstance(n, int) for n in parts):
                break
            parts = []
    date = "-".join(str(n) if i == 0 else f"{n:02d}" for i, n in enumerate(parts[:3]))
    doi = _doi(work.get("DOI", ""))
    meta = {"title_en": html.unescape(_first_text(work.get("title"))),
            "authors": ", ".join(" ".join(filter(None, (_text(a.get("given")), _text(a.get("family"))))) or _text(a.get("name")) for a in _objects(work.get("author"))),
            "venue": _first_text(work.get("container-title")), "year": str(parts[0]) if parts else "", "date": date,
            "doi": doi, "url": "https://doi.org/" + doi if doi else work.get("URL", "")}
    return {k: v for k, v in meta.items() if v}


class _Resolution:
    """One import attempt. A failed URL/DOI is never revisited recursively."""
    def __init__(self):
        self.urls = set()
        self.dois = set()
        self.errors: list[SourceError] = []
        self.title = ""
        self.deadline = time.monotonic() + 120

    def get(self, url: str, *, json_data=False, pdf=False):
        url = urllib.parse.urldefrag(url)[0]
        if url in self.urls:
            return None
        if len(self.urls) >= 18 or time.monotonic() >= self.deadline:
            self.errors.append(SourceError("导入尝试已结束，请检查网络后重试", "network"))
            return None
        self.urls.add(url)
        try:
            data, ctype, final = _get(url, "application/json" if json_data else "application/pdf,text/html,*/*",
                                      min(60 if pdf else 20, max(1, self.deadline - time.monotonic())),
                                      5_000_000 if json_data else MAX_PDF)
            self.urls.add(urllib.parse.urldefrag(final)[0])
            if json_data:
                result = json.loads(data)
                if not isinstance(result, dict):
                    raise ValueError()
                return result
            return data, ctype, final
        except SourceError as e:
            self.errors.append(e)
        except (ValueError, UnicodeError):
            self.errors.append(SourceError("检索服务返回的数据无法读取，请稍后重试", "invalid_response"))
        return None

    def page(self, url: str, inherited=None, *, pdf=False):
        result = self.get(url, pdf=pdf)
        if result is None:
            return None
        data, _, final = result
        meta = {"url": url, **(inherited or {})}
        if data.startswith(b"%PDF"):
            return data, _name(final), meta
        if pdf:
            self.errors.append(SourceError("下载地址返回了网页而非 PDF，可能需要登录或订阅", "access_denied"))
            return None
        page = data[:3_000_000].decode("utf-8", "replace")
        tags = _page_meta(page)
        first = lambda k: (tags.get(k) or [""])[0].strip()  # noqa: E731
        date = first("citation_publication_date") or first("citation_date") or first("dc.date")
        fields = {"title_en": first("citation_title") or first("dc.title") or first("og:title"),
                  "authors": ", ".join(_first_last(a) for a in tags.get("citation_author", [])[:50]),
                  "date": date, "year": (re.search(r"(19|20)\d{2}", date) or [""])[0],
                  "venue": first("citation_journal_title") or first("citation_conference_title"),
                  "doi": _doi(first("citation_doi") or first("dc.identifier"))}
        meta = {**{k: v for k, v in fields.items() if v}, **meta}
        self.title = meta.get("title_en") or self.title
        links = tags.get("citation_pdf_url", [])[:3]
        if not links:
            links = re.findall(r"href=[\"']([^\"']+\.pdf(?:\?[^\"']*)?)[\"']", page, re.I)[:3]
        for link in links:
            found = self.page(urllib.parse.urljoin(final, html.unescape(link)), meta, pdf=True)
            if found:
                return found
        if meta.get("doi"):
            return self.doi(meta["doi"], meta)
        return None

    def arxiv(self, aid: str, meta=None):
        if not ARXIV_RE.fullmatch(aid):
            return None
        meta = {"arxiv": f"arXiv:{aid}", "url": f"https://arxiv.org/abs/{aid}", **(meta or {})}
        found = self.page(f"https://arxiv.org/pdf/{aid}", meta, pdf=True)
        if found:
            # Metadata is optional: failure after a successful PDF must not undo the import.
            result = self.get(f"https://export.arxiv.org/api/query?id_list={aid}") if not meta.get("title_en") else None
            if result:
                try:
                    meta = {**_parse_arxiv_atom(result[0]), **meta}
                except ET.ParseError:
                    pass
            return found[0], f"{aid.replace('/', '-')}.pdf", meta
        return None

    def s2(self, paper: dict, inherited=None):
        meta = {**_s2_meta(paper), **(inherited or {})}
        self.title = meta.get("title_en") or self.title
        ext = _obj(paper.get("externalIds"))
        if _text(ext.get("ArXiv")):
            found = self.arxiv(ext["ArXiv"], meta)
            if found:
                return found
        oa = _text(_obj(paper.get("openAccessPdf")).get("url"))
        return self.page(oa, meta) if oa else None

    def crossref(self, work: dict, inherited=None):
        meta = {**_crossref_meta(work), **(inherited or {})}
        self.title = meta.get("title_en") or self.title
        for link in _objects(work.get("link"))[:4]:
            url = _text(link.get("URL"))
            if url and (link.get("content-type") == "application/pdf" or urllib.parse.urlparse(url).path.lower().endswith(".pdf")):
                found = self.page(url, meta, pdf=True)
                if found:
                    return found
        primary = _text(_obj(_obj(work.get("resource")).get("primary")).get("URL")) or _text(work.get("URL"))
        return self.page(primary, meta) if primary else None

    def doi(self, doi: str, inherited=None):
        doi = _doi(doi)
        if not doi or doi.lower() in self.dois:
            return None
        self.dois.add(doi.lower())
        meta = {"doi": doi, "url": "https://doi.org/" + doi, **(inherited or {})}
        # These DOI registrants expose stable public full-text addresses.
        if doi.lower().startswith("10.18653/v1/"):
            found = self.page("https://aclanthology.org/" + doi.split("/", 2)[2] + "/", meta)
            if found:
                return found
        if doi.lower().startswith("10.48550/arxiv."):
            found = self.arxiv(doi.split(".", 2)[2], meta)
            if found:
                return found
        paper = self.get(S2 + urllib.parse.quote("DOI:" + doi, safe=":/") + "?fields=" + S2_FIELDS, json_data=True)
        if paper:
            found = self.s2(paper, meta)
            if found:
                return found
        result = self.get("https://api.crossref.org/works/" + urllib.parse.quote(doi, safe=""), json_data=True)
        work = (result or {}).get("message")
        if isinstance(work, dict) and _doi(work.get("DOI", "")).lower() == doi.lower():
            found = self.crossref(work, meta)
            if found:
                return found
        return self.page("https://doi.org/" + doi, meta)

    def by_title(self, title: str):
        expected = _title_key(title)
        result = self.get(S2 + "search/match?query=" + urllib.parse.quote(title) + "&fields=" + S2_FIELDS, json_data=True)
        for paper in _objects(_obj(result).get("data")):
            if _title_key(paper.get("title", "")) != expected:
                continue
            found = self.s2(paper)
            if found:
                return found
            doi = _text(_obj(paper.get("externalIds")).get("DOI"))
            if doi:
                found = self.doi(doi, _s2_meta(paper))
                if found:
                    return found
        params = urllib.parse.urlencode({"query.bibliographic": title, "rows": 3})
        result = self.get("https://api.crossref.org/works?" + params, json_data=True)
        for work in _objects(_obj(_obj(result).get("message")).get("items")):
            if _title_key(_crossref_meta(work).get("title_en", "")) != expected:
                continue
            found = self.crossref(work)
            if found:
                return found
            if work.get("DOI"):
                found = self.doi(work["DOI"], _crossref_meta(work))
                if found:
                    return found
        query = 'ti:"' + title.replace('"', " ") + '"'
        result = self.get("https://export.arxiv.org/api/query?" + urllib.parse.urlencode({"search_query": query, "max_results": 3}))
        if result:
            try:
                for entry in ET.fromstring(result[0]).findall("{http://www.w3.org/2005/Atom}entry"):
                    ns = {"a": "http://www.w3.org/2005/Atom"}
                    if _title_key(entry.findtext("a:title", "", ns)) != expected:
                        continue
                    aid = ARXIV_RE.search(entry.findtext("a:id", "", ns))
                    feed = ET.Element("{http://www.w3.org/2005/Atom}feed")
                    feed.append(entry)
                    if aid:
                        self.title = title
                        found = self.arxiv(aid.group(1), _parse_arxiv_atom(ET.tostring(feed)))
                        if found:
                            return found
            except ET.ParseError:
                self.errors.append(SourceError("arXiv 检索返回的数据无法读取", "invalid_response"))
        return None

    def failure(self):
        prefix = f"已找到《{self.title}》，但全文未导入。" if self.title else "导入未完成。"
        for code in ("network", "rate_limited", "service_unavailable", "invalid_response", "too_large", "access_denied"):
            error = next((e for e in self.errors if e.code == code), None)
            if error:
                return SourceError(prefix + str(error), code)
        if self.title:
            return SourceError(prefix + "没有取得可下载的 PDF；可从出版社或学校图书馆下载后导入。", "no_fulltext")
        return SourceError("未找到可导入的论文。请核对完整标题、DOI 或论文网址；也可直接导入 PDF。", "not_found")


def fetch(ref: str) -> tuple[bytes, str, dict]:
    """Resolve one reference with bounded fallbacks, preserving actual failure causes."""
    if not isinstance(ref, str) or not ref.strip() or len(ref) > 2000:
        raise SourceError("请填写链接、arXiv 编号、DOI 或完整论文标题（最多 2000 字）", "invalid_input")
    ref = ref.strip().strip("<>")
    is_url = bool(re.match(r"https?://", ref, re.I))
    parsed = urllib.parse.urlparse(ref) if is_url else None
    host = (parsed.hostname or "").lower() if parsed else ""
    resolver = _Resolution()
    found = None
    arxiv = ARXIV_RE.search(ref)
    if arxiv and (host in ("arxiv.org", "www.arxiv.org", "export.arxiv.org") or
                  (not is_url and re.fullmatch(r"(?:arxiv:)?\s*" + re.escape(arxiv.group(1)) + r"(?:\.pdf)?", ref, re.I))):
        found = resolver.arxiv(arxiv.group(1))
    elif _doi(ref) and (not is_url or host in ("doi.org", "dx.doi.org", "www.doi.org")):
        value = urllib.parse.unquote(parsed.path).lstrip("/") if parsed else ref
        found = resolver.doi(_doi(value))
    elif is_url:
        match = re.fullmatch(r"/(?:forum|pdf)", parsed.path) if host in ("openreview.net", "www.openreview.net") else None
        oid = (urllib.parse.parse_qs(parsed.query).get("id") or [""])[0]
        if match and re.fullmatch(r"[\w-]+", oid):
            found = resolver.page("https://openreview.net/pdf?" + urllib.parse.urlencode({"id": oid}), {"url": ref, "venue": "OpenReview"}, pdf=True)
            if found:
                found = found[0], f"openreview-{oid}.pdf", found[2]
        elif host in ("aclanthology.org", "www.aclanthology.org") and re.fullmatch(r"/[\w.-]+(?:/)?", parsed.path):
            aid = parsed.path.strip("/").removesuffix(".pdf")
            found = resolver.page(f"https://aclanthology.org/{aid}.pdf", {"url": f"https://aclanthology.org/{aid}/", "venue": "ACL Anthology"}, pdf=True)
        elif host in ("biorxiv.org", "www.biorxiv.org", "medrxiv.org", "www.medrxiv.org") and parsed.path.startswith("/content/"):
            path = re.sub(r"(?:\.full(?:\.pdf)?|\.abstract)$", "", parsed.path)
            base = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))
            found = resolver.page(base + ".full.pdf", {"url": base}, pdf=True) or resolver.page(ref)
        elif host in ("ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov") and (pmcid := re.search(r"PMC\d+", parsed.path, re.I)):
            found = resolver.page(ref)
            if not found:
                paper = resolver.get(S2 + "PMCID:" + pmcid.group(0).upper() + "?fields=" + S2_FIELDS, json_data=True)
                if paper:
                    found = resolver.s2(paper)
        else:
            found = resolver.page(ref, pdf=parsed.path.lower().endswith(".pdf"))
    else:
        if re.match(r"[\w+.-]+://", ref) or len(_title_key(ref)) < 4:
            raise SourceError("请输入 HTTP/HTTPS 论文地址、DOI、arXiv 编号或完整论文标题", "invalid_input")
        found = resolver.by_title(ref)
    if found:
        return found
    raise resolver.failure()


def enrich(first_page_text: str, meta: dict) -> dict:
    """本地 PDF：从第一页文字里找 arXiv 编号或 DOI，补全元数据。只补空着的字段。"""
    if meta.get("authors") and meta.get("year"):
        return {}
    text = first_page_text[:6000]
    found: dict = {}
    m = re.search(r"arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)", text)
    if m:
        found = arxiv_meta(m.group(1))
    else:
        d = DOI_RE.search(text)
        p = s2_lookup("DOI:" + d.group(1)) if d else None
        if p:
            found = _s2_meta(p)
    return {k: v for k, v in found.items() if v and not meta.get(k)}
