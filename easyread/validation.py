"""Reject incomplete model output before it replaces saved translations."""
from __future__ import annotations


def batch_problems(data: dict, pages: list[int]) -> list[str]:
    problems = []
    blocks = data.get("blocks", [])
    expected, seen = set(pages), set()
    for block in blocks:
        page = block.get("page")
        if page not in expected:
            problems.append(f"{block.get('id')}：页码 {page} 不属于本批 {pages}")
        else:
            seen.add(page)
        kind = block.get("type")
        if kind in ("para", "heading", "note") and not str(block.get("zh") or "").strip():
            problems.append(f"{block.get('id')}：中文译文为空")
        if kind == "math" and not str(block.get("tex") or "").strip():
            problems.append(f"{block.get('id')}：公式内容为空")
        if kind == "list" and not block.get("items"):
            problems.append(f"{block.get('id')}：列表没有内容")
    missing = sorted(expected - seen)
    if missing:
        problems.append(f"缺少第 {missing} 页的内容；参考文献页也必须输出带 page 的 references 块，不能只返回条目数组")
    return problems
