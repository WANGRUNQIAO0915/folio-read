/* 行内标记：$TeX$、**粗体**、*斜体*、`代码`、[n] 引用，以及“公式 (1) / 表 2 / 第 2.2 节 / 附录 A”这类交叉引用。
   译文、讨论、笔记都用同一套，用户编辑时看到的就是这套原始标记。 */
(function (PR) {
  "use strict";
  const MATH = /(?<!\\)\$((?:\\\$|[^$])+?)(?<!\\)\$/g;
  const mathCache = new Map();

  PR.safeLink = function (value) {
    value = String(value || '').trim();
    if (!value || value.length > 4096 || /[\s\\\x00-\x1f\x7f]/.test(value)) return '';
    if (/^www\./i.test(value)) value = 'https://' + value;
    if (/^10\.\d{4,9}\//.test(value)) value = 'https://doi.org/' + value;
    try {
      const url = new URL(value);
      return ((['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username) ||
        (url.protocol === 'mailto:' && url.pathname.includes('@'))) ? url.href : '';
    } catch (_) { return ''; }
  };
  PR.externalLink = function (label, destination) {
    const url = PR.safeLink(destination);
    const text = PR.md(label, { links: false, cite: false, xref: false });
    return url ? '<a class="external-link" href="' + PR.esc(url) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>' : text;
  };

  function sourceDestination(value, sourceLinks) {
    const norm = text => String(text || '').replace(/\s/g, '').replace(/^https?:\/\//i, '');
    const label = norm(value), destinations = new Set();
    for (const link of sourceLinks || []) {
      if (/^(?:https?:\/\/|www\.|10\.\d{4,9}\/)/i.test(link.label || '') && norm(link.label) === label) {
        const url = PR.safeLink(link.url);
        if (url) destinations.add(url);
      }
    }
    return destinations.size === 1 ? [...destinations][0] : PR.safeLink(value);
  }

  function protectLinks(text, keep, sourceLinks) {
    // Read balanced parentheses, including URLs such as /dataset_(v2).
    const opening = /\[([^\]\n]+)\]\(/g;
    let out = '', cursor = 0, match;
    while ((match = opening.exec(text))) {
      let end = opening.lastIndex, depth = 1;
      for (; end < text.length && depth && text[end] !== '\n'; end++) {
        if (text[end] === '\\') { end++; continue; }
        if (text[end] === '(') depth++;
        if (text[end] === ')') depth--;
      }
      if (depth) continue;
      const raw = text.slice(opening.lastIndex, end - 1).trim();
      const destination = raw.match(/^(?:<([^>]+)>|(\S+?))(?:\s+["'][^\n]*["'])?$/);
      const url = destination && sourceDestination((destination[1] || destination[2]).replace(/\\([()])/g, '$1'), sourceLinks);
      out += text.slice(cursor, match.index) + keep(url ? PR.externalLink(match[1], url) : PR.esc(text.slice(match.index, end)));
      cursor = end; opening.lastIndex = end;
    }
    text = out + text.slice(cursor);
    return text.replace(/\b(?:https?:\/\/|www\.|mailto:)[^\s<>"'“”‘’（）【】《》〈〉，。；！？、\uE000-\uE003]+|\b10\.\d{4,9}\/[^\s<>"'“”‘’（）【】《》〈〉，。；！？、\uE000-\uE003]+/gi, value => {
      let label = value.replace(/[.,;:!?]+$/, '');
      while (/[)\]}]$/.test(label)) {
        const close = label.slice(-1), open = { ')': '(', ']': '[', '}': '{' }[close];
        if (label.split(close).length <= label.split(open).length) break;
        label = label.slice(0, -1);
      }
      const url = sourceDestination(label, sourceLinks);
      return url ? keep(PR.externalLink(label, url)) + value.slice(label.length) : value;
    });
  }

  PR.tex = function (tex, display) {
    const key = (display ? "D" : "I") + tex;
    if (mathCache.has(key)) return mathCache.get(key);
    let html;
    try {
      html = katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: "ignore", trust: false });
    } catch (e) {
      html = '<code title="公式渲染失败">' + PR.esc(tex) + "</code>";
    }
    mathCache.set(key, html);
    return html;
  };

  function citeLinks(s) {
    return s.replace(/\[(\d+(?:\s*[,，–-]\s*\d+)*)\]/g, (m, inner) => {
      const parts = inner.split(/(\s*[,，–-]\s*)/);
      const linked = parts.map((p) => (/^\d+$/.test(p) && PR.refById && PR.refById[p])
        ? '<a class="cite" data-ref="' + p + '">' + p + "</a>" : p).join("");
      return "[" + linked + "]";
    });
  }

  function xref(kind, key, label) {
    const ix = PR.xindex && PR.xindex[kind];
    if (!ix || !ix[key]) return label;
    return '<a class="xref" data-kind="' + kind + '" data-key="' + PR.esc(key) + '">' + label + "</a>";
  }

  function xrefLinks(s) {
    // 公式 (9) 和 (10)：把这一串里每个编号都链上
    s = s.replace(/公式\s*[（(]\d+[）)](?:\s*(?:和|与|及|、|或|,|，)\s*[（(]\d+[）)])*/g,
      (m) => m.replace(/[（(](\d+)[）)]/g, (mm, n) => xref("eq", n, mm)));
    s = s.replace(/公式\s*(\d+)(?![\d.）)])/g, (m, n) => xref("eq", n, m));
    s = s.replace(/表\s*(\d+)/g, (m, n) => xref("tab", n, m));
    s = s.replace(/图\s*(\d+)/g, (m, n) => xref("fig", n, m));
    s = s.replace(/第\s*(\d+(?:\.\d+)*)\s*节/g, (m, n) => xref("sec", n, m));
    s = s.replace(/附录\s*([A-Z])(?![a-zA-Z])/g, (m, n) => xref("sec", n, m));
    // 英文原文里的
    s = s.replace(/\b(Equations?)\s+(\d+)(?:\s+(and)\s+(\d+))?/g, (m, w, a, and, b) =>
      w + " " + xref("eq", a, a) + (b ? " " + and + " " + xref("eq", b, b) : ""));
    s = s.replace(/\bTable\s+(\d+)/g, (m, n) => xref("tab", n, m));
    s = s.replace(/\bFigure\s+(\d+)/g, (m, n) => xref("fig", n, m));
    s = s.replace(/\bSection\s+(\d+(?:\.\d+)*)/g, (m, n) => xref("sec", n, m));
    s = s.replace(/\bAppendix\s+([A-Z])\b/g, (m, n) => xref("sec", n, m));
    return s;
  }

  /* AI 回答里偶尔会带出段落编号 [p4-5]、[eq7]，换成读者看得懂的“式 7”“第 4 页” */
  function blockLabel(s) {
    return s.replace(/\[([a-z]+\d*(?:-[\w-]+)?)\]/g, (m, id) => {
      const b = PR.blockById && PR.blockById[id];
      if (!b) return m;
      return b.type === "math" && b.tag ? "（式 " + b.tag + "）" : b.page ? "（第 " + b.page + " 页）" : m;
    });
  }

  function inline(text, opts) {
    let s = blockLabel(PR.esc(text).replace(/\\\$/g, "$"));
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    if (opts.cite !== false) s = citeLinks(s);
    if (opts.xref !== false) s = xrefLinks(s);
    return s.replace(/\n/g, "<br>");
  }

  /* 一行/一段文字 -> HTML */
  PR.md = function (text, opts) {
    opts = opts || {};
    text = String(text == null ? "" : text).replace(/[\uE000-\uE003]/g, '');
    const protectedHtml = [];
    const keep = html => '\uE002' + (protectedHtml.push(html) - 1) + '\uE003';
    text = text.replace(/`([^`\n]+)`/g, (_, code) => keep('<code>' + PR.esc(code) + '</code>'));
    if (opts.links !== false) text = protectLinks(text, keep, opts.sourceLinks);
    // 公式先换成占位符再处理粗体等标记，这样 **粗体里带 $公式$** 也能认出来
    const maths = [];
    MATH.lastIndex = 0;
    const s = text.replace(MATH, (m, t) => "" + (maths.push(t) - 1) + "");
    return inline(s, opts).replace(/(\d+)/g, (m, i) => PR.tex(maths[i].replace(/\\\$/g, "\\$"), false))
      .replace(/\uE002(\d+)\uE003/g, (_, i) => protectedHtml[i]);
  };

  /* 多段文字（讨论、笔记正文）：空行分段；$$...$$ 是行间公式——AI 常把它紧贴在上一行文字或列表后面，也要拆出来 */
  PR.mdBlocks = function (text, opts) {
    return String(text || "").trim().split(/\n\s*\n/).map((p) =>
      p.split(/(?<!\\)\$\$([\s\S]+?)\$\$/).map((part, i) =>
        i % 2 ? '<div class="eq">' + PR.tex(part.trim(), true) + "</div>" : para(part, opts)).join("")).join("");
  };

  function para(p, opts) {
    p = p.trim();
    if (!p) return "";
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(p)) return "<hr>";
    const h = p.match(/^#{1,4}\s+(.+)$/);
    if (h) return '<p class="md-h">' + PR.md(h[1], opts) + "</p>";
    const lines = p.split("\n");
    // 列表：从某行起每行都以 “- ”“* ”或“1. ”开头（AI 的回答常用“引子：\n- …\n- …”）
    const isItem = (l) => /^\s*([-*•]|\d+[.、)])\s+/.test(l);
    const k = lines.findIndex(isItem);
    if (k >= 0 && lines.slice(k).every(isItem)) {
      const ordered = /^\s*\d/.test(lines[k]);
      return (k ? "<p>" + PR.md(lines.slice(0, k).join("\n"), opts) + "</p>" : "") + (ordered ? "<ol>" : "<ul>") +
        lines.slice(k).map((l) => "<li>" + PR.md(l.replace(/^\s*([-*•]|\d+[.、)])\s+/, ""), opts) + "</li>").join("") + (ordered ? "</ol>" : "</ul>");
    }
    return "<p>" + PR.md(p, opts) + "</p>";
  }

  /* 去掉标记的纯文字，给目录、列表摘要用 */
  PR.plain = (text) => String(text || "").replace(MATH, (m, t) => t).replace(/\*\*|`/g, "");
})(window.PR);
