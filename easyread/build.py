"""把阅读页和一篇论文打成单个 HTML：离线打开、发给别人看。

单文件里的修改存在浏览器；在页面“说明”里导出后，用 `easyread merge ID --from 导出.json` 并回文献库。
"""
from __future__ import annotations

import base64
import html as htmllib
import json
import re
from pathlib import Path

from .config import WEB
from .store import Workspace

_LINK = re.compile(r'<link rel="stylesheet" href="/web/([^"]+)"\s*/?>')
_SCRIPT = re.compile(r'<script src="/web/([^"]+)"></script>')


def _data_uri(path: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def _inline_css(rel: str) -> str:
    path = WEB / rel
    css = path.read_text(encoding="utf-8")
    if "katex" in rel:  # 字体转成 data URI，离线也能显示公式
        css = re.sub(r"url\((fonts/[^)]+\.woff2)\)", lambda m: f"url({_data_uri(path.parent / m.group(1), 'font/woff2')})", css)
        css = re.sub(r",\s*url\(fonts/[^)]+\.(woff|ttf)\) format\(\"(woff|truetype)\"\)", "", css)
    return f"<style>{css}</style>"


def _script(rel: str) -> str:
    js = (WEB / rel).read_text(encoding="utf-8").replace("</script", "<\\/script")
    return f"<script>{js}</script>"


def build(ws: Workspace, out: Path | None = None, assets: Path | None = None, extra: dict | None = None) -> Path:
    """assets：图片不内嵌、另存到这个目录（放到网站上时页面小很多，图按需加载）；extra：额外写进页面数据的内容。"""
    from . import figures
    # 在自动配图前校验已有路径，不能把非法路径悄悄变成缺图绕过导出检查。
    for b in (ws.load("paper") or {}).get("blocks", []):
        rel = b.get("src")
        if rel and (not (ws.root / rel).resolve().is_relative_to(ws.root) or
                    rel.replace("\\", "/").split("/", 1)[0] not in ("pages", "figures")):
            raise ValueError("导出图片路径必须位于这篇论文的 pages 或 figures 目录")
    figures.ensure(ws)
    page = (WEB / "reader.html").read_text(encoding="utf-8")
    page = _LINK.sub(lambda m: _inline_css(m.group(1)), page)
    page = _SCRIPT.sub(lambda m: _script(m.group(1)), page)
    page = page.replace('<link rel="icon" href="/web/favicon.svg">', f'<link rel="icon" href="{_data_uri(WEB / "favicon.svg", "image/svg+xml")}">')
    from .links import for_reader
    paper = for_reader(ws)
    images = {}
    rels = [p["img"] for p in paper.get("meta", {}).get("pages", [])] + [b["src"] for b in paper.get("blocks", []) if b.get("src")]
    for rel in rels:
        src = (ws.root / rel).resolve()
        if not src.is_relative_to(ws.root.resolve()) or rel.replace("\\", "/").split("/", 1)[0] not in ("pages", "figures"):
            raise ValueError("导出图片路径必须位于这篇论文的 pages 或 figures 目录")
        if not src.is_file():
            continue
        if assets:
            dst = assets / rel.replace("/", "-")
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
            images[rel] = f"{assets.name}/{dst.name}"
        else:
            images[rel] = _data_uri(src, "image/webp")
    data = {n: ws.load(n) for n in ("discussion", "reader", "layout", "item", "chat")}
    data.update({"paper": paper, "images": images}, **(extra or {}))
    payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    page = page.replace("<!--PR:DATA-->", f'<script id="pr-data" type="application/json">{payload}</script>')
    title = paper.get("meta", {}).get("title_zh") or paper.get("meta", {}).get("title_en") or "论文"
    page = re.sub(r"<title>.*?</title>", f"<title>{htmllib.escape(title)}</title>", page, count=1)
    stem = re.sub(r'[\\/:*?"<>|]', "", paper.get("meta", {}).get("short_zh") or ws.id)
    out = out or ws.root / f"{stem}-离线版.html"
    out.write_text(page, encoding="utf-8")
    return out
