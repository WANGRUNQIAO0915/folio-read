"""Claude Code / Codex CLI 能选哪些模型，给设置页的下拉框用。

- Codex：读 ~/.codex/models_cache.json（Codex 自己从服务端拉的名单），只要 /model 里列出来的那些，按它的顺序；
  默认模型是 ~/.codex/config.toml 里的 model。
- Claude：opus / sonnet / haiku 是 Claude Code 的别名，会用它支持的最新版；
  实际是哪个版本，第一次回答时记在 .models-seen.json（见 chat_models.remember），有就一起显示。
"""
from __future__ import annotations

import json
from pathlib import Path

from . import chat_models

CLAUDE_ALIASES = [("opus", "Opus", "最强"), ("sonnet", "Sonnet", "快、省"), ("haiku", "Haiku", "最快最省")]


def codex() -> dict:
    """{"default": slug, "models": [{"id", "name", "desc"}]}；Codex 没装或没登录过就是空名单。"""
    out: list[dict] = []
    try:
        data = json.loads((Path.home() / ".codex" / "models_cache.json").read_text(encoding="utf-8"))
        ms = [m for m in data.get("models") or [] if m.get("visibility") == "list" and m.get("slug")]
        ms.sort(key=lambda m: m.get("priority", 99))
        out = [{"id": m["slug"], "name": m.get("display_name") or m["slug"], "desc": m.get("description") or ""} for m in ms]
    except (OSError, ValueError, AttributeError):
        pass
    return {"default": chat_models.codex_default_model(), "models": out}


def claude() -> dict:
    """{"models": [{"id": "opus", "name": "Opus", "desc": "最强", "actual": "Claude Opus 5.5"}]}"""
    return {"models": [{"id": a, "name": n, "desc": d, "actual": chat_models.pretty(chat_models.actual_of(a)) if chat_models.actual_of(a) else ""}
                       for a, n, d in CLAUDE_ALIASES]}


def listing() -> dict:
    return {"claude": claude(), "codex": codex()}
