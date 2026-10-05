"""Synthetic translated paper and real-PDF inspection for print regression tests.

All inputs are invented. Uses only application dependencies; no model or network.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def fixture(root: Path) -> None:
    from PIL import Image, ImageDraw
    from easyread.build import build
    from easyread.store import Workspace, write_json_atomic

    root.mkdir(parents=True, exist_ok=True)
    workspace = root / "library" / "print-fixture"
    (workspace / "figures").mkdir(parents=True, exist_ok=True)
    (workspace / "pages").mkdir(exist_ok=True)
    figure = Image.new("RGB", (720, 240), "white")
    draw = ImageDraw.Draw(figure)
    for index, color in enumerate(("#185a8d", "#48a999", "#de8a35")):
        x = 30 + index * 230
        draw.rectangle((x, 35, x + 200, 205), fill=color)
        draw.text((x + 30, 100), f"FIGURE {index + 1}", fill="white")
    figure.save(workspace / "figures" / "available.webp", lossless=True)
    original = Image.new("RGB", (600, 760), "white")
    draw = ImageDraw.Draw(original)
    draw.rectangle((20, 20, 580, 740), outline="#185a8d", width=4)
    draw.text((80, 150), "UNTRANSLATED ORIGINAL PAGE 4", fill="black")
    original.save(workspace / "pages" / "original.webp", lossless=True)

    blocks = [
        {"id": "intro", "type": "heading", "page": 1, "num": "1", "zh": "研究方法", "en": "Methods"},
        {"id": "p-edit", "type": "para", "page": 1, "zh": "OLD_PARAGRAPH_TRANSLATION", "en": "ORIGINAL_TRANSLATED_PARA"},
        {"id": "list", "type": "list", "page": 1, "ordered": True, "items": [
            {"zh": "OLD_LIST_TRANSLATION", "en": "ORIGINAL_TRANSLATED_LIST"},
            {"zh": "OLD_EMPTY_LIST_TRANSLATION", "en": "SOURCE_EMPTY_LIST"},
            {"zh": "列表保留项", "en": "ORIGINAL_SECOND_LIST"},
        ]},
        {"id": "fig", "type": "figure", "page": 1, "num": "1", "src": "figures/available.webp",
         "image_width": 720, "image_height": 240, "caption_zh": "OLD_FIGURE_CAPTION", "caption_en": "ORIGINAL_TRANSLATED_CAPTION"},
        {"id": "empty-caption", "type": "figure", "page": 1, "num": "2", "src": "figures/available.webp",
         "caption_zh": "OLD_EMPTY_CAPTION", "caption_en": "SOURCE_EMPTY_CAPTION"},
        {"id": "math", "type": "math", "page": 1, "tex": r"E = mc^2 + \frac{a}{b}", "tag": "1"},
        {"id": "wide-math", "type": "math", "page": 1,
         "tex": " + ".join(f"x_{{{n}}}" for n in range(1, 25)) + " = 300", "tag": "2"},
        {"id": "table", "type": "table", "page": 2, "num": "1", "head": [["指标", "组一", "组二", "说明"]],
         "rows": [["TABLE_VALUE_42", "42", "84", "可换行的中文长表格内容" * 10],
                  ["WIDE_IDENTIFIER_" + "x" * 90, "0.25", "0.50", "表格第二行"]],
         "caption_zh": "表一：结果", "caption_en": "ORIGINAL_TABLE_CAPTION"},
        {"id": "missing", "type": "para", "page": 2, "en": "MISSING_TRANSLATION_SOURCE preserved for review."},
        {"id": "agent-note", "type": "note", "page": 2, "zh": "PRIVATE_INLINE_AGENT_NOTE"},
    ]
    for number in range(1, 25):
        blocks.append({"id": f"long-{number}", "type": "para", "page": 2 if number < 10 else 3,
                       "zh": f"译文段落 {number:02d}。" + "这是用于验证分页的中文正文，保留研究结果、公式和引用并检查页面边界。" * 4,
                       "en": f"ORIGINAL_LONG_{number:02d} " + "Synthetic original paragraph for bilingual pagination. " * 5})
    blocks += [{"id": "refs", "type": "references", "page": 3, "zh": "参考文献", "en": "References"}]
    paper = {
        "meta": {"title_zh": "译文导出测试论文", "title_en": "Synthetic Translated Export Paper", "short_zh": "译文测试",
                 "authors": "Synthetic Researcher", "source_sha256": "print-fixture", "text_status": "translated",
                 "pages": [{"n": n, "img": "pages/original.webp", "width": 600, "height": 760} for n in range(1, 5)]},
        "translation": {"done_pages": [1, 2, 3]}, "blocks": blocks,
        "references": [{"id": "1", "text": "REFERENCE_SENTINEL. Synthetic Researcher (2026). Local-only test publication."}],
    }
    at = "2026-01-02T03:04:05Z"
    reader = {"schema": 2, "rev": 4, "edits": {
        "p-edit": {"zh": "保存后的中文段落 SAVED_PARAGRAPH", "base": "older", "at": at},
        "list#0": {"zh": "保存后的列表 SAVED_LIST", "at": at},
        "list#1": {"zh": "", "at": at},
        "fig#caption": {"zh": "图一：保存后的图注 SAVED_CAPTION", "at": at},
        "empty-caption#caption": {"zh": "", "at": at},
    }, "notes": {"private-note": {"id": "private-note", "kind": "note", "anchor": "p-edit",
                                    "body": "PRIVATE_READER_NOTE", "created": at, "updated": at}},
        "paper_note": {"body": "PRIVATE_PAPER_NOTE", "at": at}, "progress": {}}
    state = {"token": "synthetic-only", "paper": paper, "reader": reader, "item": {}, "job": {},
             "layout": {}, "versions": {}, "engine": "none",
             "discussion": {"entries": [{"id": "private-discussion", "kind": "explain", "anchor": "p-edit",
                                           "body": "PRIVATE_DISCUSSION", "at": at}]}}
    for name in ("paper", "reader", "item", "discussion", "layout"):
        write_json_atomic(workspace / f"{name}.json", state[name])
    write_json_atomic(root / "state.json", state)
    build(Workspace(workspace), root / "offline.html")
    print(json.dumps({"root": str(root), "workspace": str(workspace), "offline": str(root / "offline.html")}))


def inspect_pdf(source: Path) -> None:
    import pdfplumber
    import pypdfium2
    from pypdf import PdfReader

    assert source.read_bytes().startswith(b"%PDF-"), "Not PDF bytes"
    reader = PdfReader(source)
    document = pypdfium2.PdfDocument(source)
    pages = []
    with pdfplumber.open(source) as pdf:
        for number, page in enumerate(pdf.pages):
            chars = [char for char in page.chars if str(char["text"]).strip()]
            # Real glyph/image bounds catch clipping that DOM snapshots cannot.
            overflow = [char["text"] for char in chars if char["x0"] < 38 or char["x1"] > page.width - 38
                        or char["top"] < 36 or char["bottom"] > page.height - 36]
            image_overflow = [image["name"] for image in page.images if image["x0"] < 38 or image["x1"] > page.width - 38
                              or image["top"] < 36 or image["bottom"] > page.height - 36]
            bitmap = document[number].render(scale=1).to_pil().convert("RGB")
            bitmap.save(source.with_name(f"{source.stem}-page-{number + 1:02d}.png"))
            nonwhite = sum(1 for r, g, b in bitmap.getdata() if min(r, g, b) < 225)
            pages.append({"width": page.width, "height": page.height, "chars": len(chars),
                          "images": len(page.images), "overflow": overflow, "image_overflow": image_overflow,
                          "nonwhite_pixels": nonwhite, "corner": bitmap.getpixel((5, 5))})
    document.close()
    print(json.dumps({"pages": pages, "text": "\n".join(page.extract_text() or "" for page in reader.pages)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("fixture", "inspect"))
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    fixture(args.path) if args.mode == "fixture" else inspect_pdf(args.path)
