"""Personal reading preferences, separate from provider credentials."""
from __future__ import annotations

from . import config
from .store import dir_lock, read_json, write_json_atomic

PROFILES = {
    "general": {"name": "通用论文精读", "terms": []},
    "geo": {"name": "遥感 / GIS / 地理生态", "terms": [
        {"en": "remote sensing", "zh": "遥感"},
        {"en": "land cover", "zh": "土地覆盖"},
        {"en": "land use", "zh": "土地利用"},
        {"en": "spatial resolution", "zh": "空间分辨率"},
        {"en": "ground truth", "zh": "地面参考数据"},
        {"en": "spatial autocorrelation", "zh": "空间自相关"},
    ]},
    "methods": {"name": "方法与统计", "terms": [
        {"en": "standard error", "zh": "标准误差"},
        {"en": "confidence interval", "zh": "置信区间"},
        {"en": "effect size", "zh": "效应量"},
        {"en": "cross-validation", "zh": "交叉验证"},
    ]},
}


def sanitize(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("自用设置必须是对象")
    profile = data.get("profile", "general")
    if profile not in PROFILES:
        raise ValueError("未知阅读方向")
    terms = data.get("glossary", [])
    if not isinstance(terms, list) or len(terms) > 300:
        raise ValueError("术语最多 300 条")
    out = {}
    for term in terms:
        if not isinstance(term, dict):
            raise ValueError("每条术语需要英文和中文")
        en, zh = str(term.get("en", "")).strip(), str(term.get("zh", "")).strip()
        if not en or not zh or len(en) > 160 or len(zh) > 160:
            raise ValueError("术语的中英文不能为空，且各不超过 160 字")
        out[en.casefold()] = {"en": en, "zh": zh}
    return {"profile": profile, "goal": str(data.get("goal", ""))[:3000], "glossary": list(out.values())}


def load() -> dict:
    return sanitize(read_json(config.HOME / "personal.json", {}) or {})


def save(data: dict) -> dict:
    data = sanitize(data)
    config.HOME.mkdir(parents=True, exist_ok=True)
    with dir_lock(config.HOME, name=".personal.lock"):
        write_json_atomic(config.HOME / "personal.json", data)
    return data


def glossary(paper_terms: list[dict] | None = None) -> list[dict]:
    prefs = load()
    merged = {}
    # Explicit personal choices take precedence over model-generated terminology.
    for term in (paper_terms or []) + PROFILES[prefs["profile"]]["terms"] + prefs["glossary"]:
        if isinstance(term, dict) and term.get("en") and term.get("zh"):
            merged[str(term["en"]).casefold()] = term
    return list(merged.values())


def reading_context() -> str:
    prefs = load()
    return ("读者的阅读方向：" + PROFILES[prefs["profile"]]["name"] +
            ("\n读者的研究目标：" + prefs["goal"] if prefs["goal"].strip() else "") +
            "\n解释时先指出作者要解决的问题、证据和适用边界，避免客套。研究目标只用于解释的相关性，不改变论文事实。")
