"""界面偏好（字号、版心、主题、快捷键……）存在数据目录的 prefs.json。

以前放在浏览器 localStorage 里，换个浏览器或清一下缓存就没了；现在以这份文件为准，浏览器里只留一份缓存。
"""
from __future__ import annotations

from . import config
from .store import read_json, write_json_atomic

ALLOWED = {"reader", "keys", "ui", "library", "import"}  # ui：功能开关 features、快捷键总开关 keys_on


def path():
    # 测试用的临时文献库各自带一份，不碰真实偏好
    return config.library_dir() / ".prefs.json" if config.temp_library() else config.HOME / "prefs.json"


def load() -> dict:
    return read_json(path(), {}) or {}


def save(patch: dict) -> dict:
    data = load()
    for k, v in (patch or {}).items():
        if k in ALLOWED and isinstance(v, dict):
            data[k] = {**(data.get(k) or {}), **v}
    write_json_atomic(path(), data)
    return data
