"""正文配图：用 PDF 的真实图像边界裁图；没有可靠边界时留给读者框选。

只更新配图字段，不重写译文、图注或读者笔记。截图文件名带内容版本，避免浏览器缓存旧图。
"""
from __future__ import annotations

import hashlib
import json
from contextlib import ExitStack

from . import pdfwork
from .log import log
from .store import Workspace, dir_lock

VERSION = 1


def _signature(b: dict) -> str:
    return hashlib.sha256(json.dumps([b.get("page"), b.get("caption_en"), b.get("image_box"),
                                     b.get("image_page")], ensure_ascii=False).encode()).hexdigest()[:16]


def _available(ws: Workspace, b: dict) -> bool:
    rel = b.get("src")
    if not isinstance(rel, str) or not rel:
        return False
    path = (ws.root / rel).resolve()
    return path.is_relative_to(ws.root) and rel.replace("\\", "/").split("/", 1)[0] in ("figures", "pages") and path.is_file()


def pending(ws: Workspace) -> bool:
    return any(b.get("type") == "figure" and not _available(ws, b) and
               (b.get("src") or b.get("figure_attempt") != f"{VERSION}:{_signature(b)}")
               for b in (ws.load("paper") or {}).get("blocks", []))


def _caption(ws: Workspace, b: dict, layout: dict, streams: dict):
    head, tail = pdfwork._anchors(b.get("caption_en") or "")
    if not head:
        return None
    # 图在首次提及处排版，实际图片可能位于下一页；以完整图注定位为准。
    candidates = [layout.get(b["id"], {}).get("page"), b.get("page")]
    if isinstance(b.get("page"), int):
        candidates += [b["page"] + 1, b["page"] - 1]
    for pn in dict.fromkeys(n for n in candidates if isinstance(n, int) and n > 0):
        if pn not in streams:
            streams[pn] = pdfwork._page_stream(ws.root / "extract", pn)
        st = streams[pn]
        if not st:
            continue
        text, idx, chars = st
        a = text.find(head)
        end = text.find(tail, a) if a >= 0 and tail else -1
        if a >= 0 and end >= 0:
            return pn, pdfwork._box(chars, idx, a, end + len(tail) - 1)
    return None


def _union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _embedded(page, cap: list, above: bool) -> list | None:
    W, H = float(page.width), float(page.height)
    boxes = [[i["x0"] / W, i["top"] / H, i["x1"] / W, i["bottom"] / H] for i in page.images]
    # 忽略 logo、背景和整页扫描图；不能把扫描页当成一幅图。
    boxes = [b for b in boxes if b[2] - b[0] >= .06 and b[3] - b[1] >= .025 and
             .004 <= (b[2] - b[0]) * (b[3] - b[1]) < .8 and
             b[0] >= 0 and b[1] >= 0 and b[2] <= 1.001 and b[3] <= 1.001]

    def score(b):
        gap = b[1] - cap[3] if above else cap[1] - b[3]
        overlap = min(b[2], cap[2]) - max(b[0], cap[0])
        if -.004 <= gap <= .12 and overlap > .2 * min(b[2] - b[0], cap[2] - cap[0]):
            return max(0, gap) + abs((b[0] + b[2]) - (cap[0] + cap[2])) * .02
        return 100

    if not boxes or min(map(score, boxes)) == 100:
        return None
    chosen = [min(boxes, key=score)]
    remaining = [b for b in boxes if b is not chosen[0]]
    # 同一幅图的多个图片对象合并裁剪，保留全部子图。
    while remaining:
        joined = []
        for b in remaining:
            if (b[1] < cap[3] - .004 if above else b[3] > cap[1] + .004):
                continue
            for c in chosen:
                dx = max(b[0] - c[2], c[0] - b[2], 0)
                dy = max(b[1] - c[3], c[1] - b[3], 0)
                if dx <= .025 and dy <= .025:
                    joined.append(b)
                    break
        if not joined:
            break
        chosen += joined
        remaining = [b for b in remaining if b not in joined]
    box = _union(chosen)
    return [max(0, box[0] - .002), max(0, box[1] - .002), min(1, box[2] + .002), min(1, box[3] + .002)]


def _fields(ws: Workspace, b: dict, page: int, box: list, method: str) -> dict:
    digest = hashlib.sha256(json.dumps([b["id"], page, box, VERSION]).encode()).hexdigest()[:20]
    src = pdfwork.crop(ws.root, page, box, "fig-" + digest)
    from PIL import Image
    with Image.open(ws.root / src) as image:
        width, height = image.size
    return {"src": src, "image_page": page, "image_box": list(box), "image_method": method,
            "image_width": width, "image_height": height}


def _save(ws: Workspace, updates: dict, expected: dict, locations: dict):
    applied = set()

    def apply(paper):
        for b in paper.get("blocks", []):
            bid = b.get("id")
            if bid in updates and _signature(b) == expected[bid]:
                b.update(updates[bid])
                b["figure_attempt"] = f"{VERSION}:{_signature(b)}"
                applied.add(bid)
    ws.update("paper", apply)
    if locations:
        ws.update("layout", lambda layout: layout.update({bid: loc for bid, loc in locations.items() if bid in applied}))
    return len(applied)


def ensure(ws: Workspace) -> int:
    """翻译落盘或首次打开旧文献时调用。失败不影响阅读，不调用模型。"""
    with dir_lock(ws.root, ".figures.lock", timeout=60):
        paper = ws.load("paper") or {}
        todo = [b for b in paper.get("blocks", []) if b.get("type") == "figure" and not _available(ws, b) and
                (b.get("src") or b.get("figure_attempt") != f"{VERSION}:{_signature(b)}")]
        if not todo:
            return 0
        layout, streams, pages = ws.load("layout") or {}, {}, {}
        updates, expected, locations = {}, {}, {}
        with ExitStack() as stack:
            pdf = None
            if (ws.root / "source.pdf").is_file():
                import pdfplumber
                pdf = stack.enter_context(pdfplumber.open(ws.root / "source.pdf"))
            for b in todo:
                expected[b["id"]] = _signature(b)
                fields = {"src": ""}
                try:
                    cap = _caption(ws, b, layout, streams)
                    pn = cap[0] if cap else b.get("image_page") or b.get("page")
                    box, method = None, "pdf-image"
                    if pdf and cap and 1 <= pn <= len(pdf.pages):
                        if pn not in pages:
                            pages[pn] = pdf.pages[pn - 1]
                        box = _embedded(pages[pn], cap[1], b.get("caption_pos") == "above")
                    if box is None and b.get("image_box"):
                        box, method = b["image_box"], "visual"
                        pn = b.get("image_page") or b.get("page")
                    if box:
                        fields = _fields(ws, b, pn, box, method)
                        hl = _union([box, cap[1]]) if cap and cap[0] == pn else box
                        locations[b["id"]] = {"page": pn, "box": hl, "src": "figure"}
                except Exception:  # noqa: BLE001
                    log.exception("自动裁图失败 %s %s", ws.id, b["id"])
                    continue  # 临时读取/渲染失败，下次打开可重试
                updates[b["id"]] = fields
        _save(ws, updates, expected, locations)
        return sum(bool(u.get("src")) for u in updates.values())


def set_crop(ws: Workspace, bid: str, page: int, box: list) -> dict:
    with dir_lock(ws.root, ".figures.lock", timeout=60):
        block = next((b for b in (ws.load("paper") or {}).get("blocks", []) if b.get("id") == bid and b.get("type") == "figure"), None)
        if not block:
            raise ValueError("找不到这幅图")
        expected = {bid: _signature(block)}
        fields = _fields(ws, block, page, box, "manual")
        if not _save(ws, {bid: fields}, expected, {bid: {"page": page, "box": box, "src": "figure"}}):
            raise ValueError("这幅图的译文刚刚更新，请重新打开截图")
        return fields
