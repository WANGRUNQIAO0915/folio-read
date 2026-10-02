"""把一篇读好的论文做成网站上的在线演示（GitHub Pages 这类静态托管）。

和“导出离线 HTML”一样是单页，区别是：图片另存成文件、按需加载；带上问 AI 的对话记录（只能看）；
顶栏有“在线演示”标记和回主页、去 GitHub 的链接。读者在演示里做的划线和笔记只存在他自己的浏览器。

    easyread demo <论文 id> --out docs/demo
"""
from __future__ import annotations

from pathlib import Path

from . import chat_store
from .build import build
from .store import Workspace

REPO = "https://github.com/Edwardxlai/easyread"


def build_demo(ws: Workspace, out_dir: Path, name: str = "index.html", credit: str = "") -> Path:
    """credit：署名和许可（比如 CC BY 4.0 要求写明作者、出处、许可，并说明是译文），显示在论文标题下面。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    reader = ws.load("reader")
    reader.pop("progress", None)  # 别让看演示的人从我读到的地方开始
    extra = {"reader": reader, "chat": {"threads": chat_store.threads(ws)},
             "demo": {"home": "../", "repo": REPO, "credit": credit}}
    return build(ws, out_dir / name, assets=out_dir / "assets", extra=extra)
