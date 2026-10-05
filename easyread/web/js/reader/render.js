/* 把 paper.json 的块排成正文。译文优先取“我的修改”，否则取译者稿。 */
(function (PR) {
  "use strict";
  const S = PR.state;

  /* ---------- 译文取值：key 形如 "s1-p1"、"tab1#caption"、"s1-recs#2" ---------- */
  PR.blockById = {};
  PR.agentText = function (key) {
    const [id, field] = key.split("#");
    const b = PR.blockById[id];
    if (!b) return "";
    if (field === "caption") return b.caption_zh || "";
    if (field != null && /^\d+$/.test(field)) return ((b.items || [])[+field] || {}).zh || "";
    return b.zh || "";
  };
  PR.editOf = function (key) { const e = (S.reader.edits || {})[key]; return e && e.zh != null ? e : null; };
  PR.textFor = function (key) { const e = PR.editOf(key); return e ? e.zh : PR.agentText(key); };
  PR.isStale = function (key) { const e = PR.editOf(key); return !!(e && e.base && e.base !== PR.hashText(PR.agentText(key))); };
  PR.blockKeys = function (b) {
    if (b.type === "list") return (b.items || []).map((_, i) => b.id + "#" + i);
    if (b.type === "table" || b.type === "figure") return [b.id + "#caption"];
    if (b.type === "math" || b.type === "references" || b.type === "note") return [];
    return [b.id];
  };

  function buildIndex() {
    PR.blockById = {};
    PR.xindex = { eq: {}, tab: {}, fig: {}, sec: {} };
    PR.headings = [];
    PR.refById = {};
    PR.citationReferences = S.paper.references || [];
    PR.order = {};
    (S.paper.references || []).forEach((r) => (PR.refById[String(r.id)] = r));
    (S.paper.blocks || []).forEach((b, i) => {
      PR.blockById[b.id] = b;
      PR.order[b.id] = i;
      if (b.type === "math" && b.tag) PR.xindex.eq[b.tag] = b.id;
      if (b.type === "table" && b.num) PR.xindex.tab[b.num] = b.id;
      if (b.type === "figure" && b.num) PR.xindex.fig[b.num] = b.id;
      if (b.type === "heading" || b.type === "references") PR.headings.push(b);
    });
    if (!PR.headings.some(h => h.type === 'references') && (S.paper.references || []).length)
      PR.headings.push({id: 'folio-references', type: 'references', zh: '参考文献'});
    PR.outline = FolioOutline.build(PR.headings, h => PR.plain(PR.textFor(h.id) || h.zh || h.en || ''));
    for (const h of PR.outline.flat) if (h.num && !PR.xindex.sec[h.num]) PR.xindex.sec[h.num] = h.id;
  }

  function staleTag(key) { return PR.isStale(key) ? '<button class="stale-tag" data-t="stale" title="你改过这段之后，译者稿又更新了">译者稿有更新</button>' : ""; }
  function zhDiv(key) {
    const b = PR.blockById[key.split('#')[0]], text = PR.textFor(key);
    let html = PR.md(text, { sourceLinks: b && b.source_links });
    if (b && b.source_link_only && !PR.editOf(key) && !/<a\b/.test(html)) html = PR.externalLink(text, b.source_link_only);
    return '<div class="zh" data-key="' + PR.esc(key) + '">' + html + staleTag(key) + '</div>';
  }

  function sourceLinksHtml(b, rendered) {
    const byUrl = new Map();
    for (const link of b.source_links || []) {
      const url = PR.safeLink(link.url);
      const existing = byUrl.get(url);
      if (url && !rendered.includes('href="' + PR.esc(url) + '"') &&
          (!existing || (link.label || '').length > (existing.label || '').length)) byUrl.set(url, link);
    }
    const links = [...byUrl.values()];
    return links.length ? '<div class="block-source-links">原文链接：' + links.map(link =>
      PR.externalLink(link.label || link.url, link.url) + ' ↗').join(' · ') + '</div>' : '';
  }
  function enDiv(text, primary, key) { return text ? '<div class="en'+(primary?' original-primary':'')+'" lang="en"'+(key?' data-key="'+PR.esc(key)+'"':'')+'>' + PR.md(text) + "</div>" : ""; }

  function captionHtml(b) {
    const key = b.id + "#caption";
    const text = PR.textFor(key);
    const m = text.match(/^([^：:]{1,12})[：:]/);
    const body = m ? '<span class="label">' + PR.esc(m[1]) + "</span>" + PR.md(text.slice(m[1].length)) : PR.md(text);
    return '<div class="caption"><div class="zh" data-key="' + key + '">' + body + staleTag(key) + "</div>" + enDiv(b.caption_en) + "</div>";
  }
  function cell(c) { return PR.md(String(c), { xref: false, cite: false }).replace(/<br>(\([^<]*\))/g, '<br><span class="sub">$1</span>'); }
  function linkify(t) { return PR.md(t, { cite: false, xref: false, sourceLinks: S.paper.source_links }); }

  const R = {
    heading(b) {
      const tag = (b.level || 1) === 1 ? "h2" : "h3";
      if(!PR.textFor(b.id) && b.en)return '<'+tag+'>'+(b.num?'<span class="num">'+PR.esc(b.num)+' </span>':'')+'<span class="en original-primary" lang="en" data-key="'+PR.esc(b.id)+'">'+PR.md(b.en)+'</span></'+tag+'>';
      return "<" + tag + ' class="zh" data-key="' + b.id + '">' + (b.num ? '<span class="num">' + PR.esc(b.num) + "</span>" : "") +
        "<span>" + PR.md(PR.textFor(b.id)) + "</span>" + staleTag(b.id) +
        (b.en ? '<span class="en-title" lang="en">' + PR.md(b.en, { cite: false, xref: false }) + "</span>" : "") + "</" + tag + ">";
    },
    para: (b) => PR.textFor(b.id) ? zhDiv(b.id) + enDiv(b.en,false,b.id) : enDiv(b.en,true,b.id),
    list(b) {
      const tag = b.ordered ? "ol" : "ul";
      return "<" + tag + ">" + (b.items || []).map((it, i) => "<li>" + (PR.textFor(b.id+'#'+i)?zhDiv(b.id + "#" + i) + enDiv(it.en,false,b.id+'#'+i):enDiv(it.en,true,b.id+'#'+i)) + "</li>").join("") + "</" + tag + ">";
    },
    math: (b) => '<div class="math-row"><div class="math-body">' + PR.tex(b.tex, true) + "</div>" + (b.tag ? '<div class="math-tag">(' + PR.esc(b.tag) + ")</div>" : "") + "</div>",
    table(b) {
      const al = (b.align || "").split("");
      const style = (i) => (al[i] ? ' style="text-align:' + ({ l: "left", r: "right", c: "center" }[al[i]] || "left") + '"' : "");
      const head = (b.head || []).map((r) => "<tr>" + r.map((c, i) => "<th" + style(i) + ">" + cell(c) + "</th>").join("") + "</tr>").join("");
      const rows = (b.rows || []).map((r) => "<tr>" + r.map((c, i) => "<td" + style(i) + ">" + cell(c) + "</td>").join("") + "</tr>").join("");
      const table = '<div class="tbl-wrap"><table class="tbl"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>";
      return b.caption_pos === "above" ? captionHtml(b) + table : table + captionHtml(b);
    },
    figure(b) {
      const page = b.image_page || b.page;
      const label = PR.esc(PR.plain(b.caption_zh || b.caption_en || "论文插图").slice(0, 160));
      const size = b.image_width > 0 && b.image_height > 0 ? ' width="' + Number(b.image_width) + '" height="' + Number(b.image_height) + '"' : '';
      const url = b.src && PR.imageUrl(b.src);
      const img = url ? '<button class="figure-image" data-fig-act="zoom" aria-label="放大' + label + '" title="点击放大">' +
        '<img src="' + PR.esc(url) + '" alt="' + label + '"' + size + ' loading="lazy"></button>' +
        '<button class="fig-missing fig-load-error" data-fig-act="original" hidden>图片未能加载，查看原文第 ' + page + ' 页</button>'
        : '<button class="fig-missing" data-fig-act="original">图见原文第 ' + page + ' 页（点击查看）</button>';
      const tools = '<div class="figure-tools">' + (url ? '<button data-fig-act="zoom">放大查看</button>' : '') +
        '<button data-fig-act="original">查看原页</button>' +
        (PR.store.mode === 'server' ? '<button data-fig-act="crop">' + (url ? '调整截图' : '框选图片') + '</button>' : '') + '</div>';
      return img + captionHtml(b) + tools;
    },
    note: (b) => '<div class="inline-note"><div class="lbl">阅读批注（非原文）</div>' + PR.mdBlocks(b.zh) + "</div>",
    references(b) {
      const refs = (S.paper.references || []).map((r) => '<li id="ref-' + PR.esc(r.id) + '"><span class="n">[' + PR.esc(r.id) + "]</span><span>" + linkify(r.text) + "</span></li>").join("");
      return '<h2 class="zh" data-key="' + b.id + '"><span>' + PR.esc(b.zh || "参考文献") + '</span><span class="en-title" lang="en">' + PR.esc(b.en || "References") + "</span></h2>" +
        '<div class="refs"><p class="note">条目保留原文，便于检索。</p><ol>' + refs + "</ol></div>";
    },
  };

  function blockClass(b) {
    let c = "blk blk-" + b.type;
    if (b.type === "heading") c += " h" + (b.level || 1) + (b.appendix ? " appendix" : "");
    if (b.type === "references") c += " blk-heading h1";
    if (b.cont) c += " cont";
    if (b.role === "abstract") c += " abstract";
    return c;
  }
  const edited = (b) => PR.blockKeys(b).some((k) => PR.editOf(k));

  function sectionHtml(b, extraClass, pageMark) {
    const rendered = R[b.type](b);
    return '<section class="' + blockClass(b) + (extraClass || "") + '" id="b-' + PR.esc(b.id) + '" data-id="' + PR.esc(b.id) + '">' +
      (pageMark ? '<button class="pgmark" data-t="page" title="看原文第 ' + b.page + ' 页">p.' + b.page + "</button>" : "") +
      rendered + sourceLinksHtml(b, rendered) + (edited(b) ? '<span class="edited-dot" title="这里有你改过的译文"></span>' : "") + "</section>";
  }

  /* 在线演示的署名和许可（CC BY 要求写明出处），网址做成链接 */
  function creditHtml() {
    const c = S.demo && S.demo.credit;
    if (!c) return "";
    const link = (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u.replace(/^https?:\/\//, "") + "</a>";
    return '<p class="demo-credit">' + PR.esc(c).replace(/https?:\/\/[^\s（）()，。,]+/g, link) + "</p>";
  }

  function headHtml() {
    const m = S.paper.meta || {};
    const tr = S.paper.translation || {};
    const kicker = [m.arxiv, m.venue, m.date].filter(Boolean).map(PR.esc).join("　·　");
    const by = [m.authors, m.affiliation].filter(Boolean).map(PR.esc).join("　·　");
    const authors = (m.authors || '').split(/[,，、;]/).map(s => s.trim()).filter(Boolean);
    const pages = (m.pages || []).length, done = (tr.done_pages || []).length;
    const scope = m.text_status==='original' ? '<b>PDF 原文</b>　'+PR.esc(m.extraction_note || '正文尚未翻译，复杂排版请核对原页。') : "<b>译文</b>　" + (pages ? (done >= pages ? "全文 " + pages + " 页" : "已译 " + done + " / " + pages + " 页") : "尚未处理") +
      (tr.note ? "　" + PR.esc(tr.note) : "") +
      '<br>正文是译文；<span class="legend-agent"></span>橙色细线是 AI 的解释和回答，<span class="legend-mine"></span>紫色细线是我的笔记，都不属于原文。';
    const linksByDestination = new Map();
    for (const link of S.paper.source_links || []) {
      const key = link.page + ':' + link.url;
      const existing = linksByDestination.get(key);
      if (PR.safeLink(link.url) && (!existing || (link.label || '').length > (existing.label || '').length)) linksByDestination.set(key, link);
    }
    const originalLinks = [...linksByDestination.values()];
    const linkIndex = originalLinks.length ? '<details class="paper-source-links"><summary>原文网页链接 · ' + originalLinks.length +
      ' 处</summary><ul>' + originalLinks.map(link => '<li><span>第 ' + Number(link.page) + ' 页</span> ' +
      PR.externalLink(link.label || link.url, link.url) + ' ↗</li>').join('') + '</ul></details>' : '';
    const blocks = S.paper.blocks || [];
    const abstract = blocks.find(b => b.role === 'abstract') || blocks.find(b => b.type === 'heading' && /^(摘要|abstract)$/i.test(PR.plain(b.zh || b.en || '').trim()));
    const body = blocks.find(b => b.type === 'heading' && (String(b.num) === '1' || /(?:^|\b)introduction\b|引言|绪论/i.test((b.en || '') + ' ' + (b.zh || '')))) ||
      blocks.find((b, i) => b.type === 'heading' && i > blocks.indexOf(abstract) &&
        (b.num || abstract) && !/摘要|abstract|关键词|keywords|article history|文章历史/i.test((b.en || '') + ' ' + (b.zh || '')));
    const jump = (b, label) => b ? '<button class="btn sm line" data-t="reading-jump" data-reading-jump="' + PR.esc(b.id) + '">' + label + ' ↓</button>' : '';
    const metaLine = [authors[0] && (authors[0] + (authors.length > 1 ? ' 等 · ' + authors.length + ' 位作者' : '')), pages && (m.text_status==='original'?'PDF 原文 · '+pages+' 页':done >= pages ? '翻译完成 · ' + pages + ' 页' : '已译 ' + done + ' / ' + pages + ' 页')].filter(Boolean).map(PR.esc).join('　·　');
    return '<header class="paper-head" id="b-head" data-id="head">' + (kicker ? '<div class="kicker">' + kicker + "</div>" : "") +
      "<h1>" + PR.esc(S.item?.naming?.title || m.title_zh || m.title_en || "（正在识别标题）") + "</h1>" +
      (S.item?.naming?.title ? '<p class="paper-naming-source">' + (S.item.naming.source === 'ai_translation' ? 'AI 翻译（非官方中文题名）' : '已确认的显示名称 · 可在文献库修改') + '</p>' : '') +
      '<p class="paper-meta-line">' + metaLine + '</p><div class="paper-head-actions">' + jump(abstract, '跳到摘要') + jump(body, '进入正文') +
      '</div><details class="paper-information"><summary>文章信息与原文链接</summary><div class="paper-information-body">' +
      ((S.item?.naming?.title || m.title_zh) && m.title_en ? '<p class="title-en" lang="en">' + PR.esc(m.title_en) + "</p>" : "") +
      (by ? '<p class="byline">' + by + "</p>" : "") + '<p class="scope">' + scope + "</p>" + window.FolioJournal.panel(m,PR.pid,PR.store.mode==='server') + linkIndex + '</div></details>' + creditHtml() + "</header>";
  }

  /* 还没译的页：放原页图，边译边读 */
  const origFig = (p) => '<figure class="orig-page" id="orig-' + p.n + '"><figcaption>原文第 ' + p.n + ' 页</figcaption><img loading="lazy" src="' + PR.imageUrl(p.img) + '" alt="原文第 ' + p.n + ' 页"></figure>';
  const failedOf = () => ((S.job || {}).state === "partial" && S.job.failed) || {};

  /* 中间漏掉的页（多半是译失败了）：就地放原页，给重试 */
  function gapHtml(pages) {
    const failed = failedOf();
    const bad = pages.filter((p) => failed[p.n]);
    const running = ["queued", "running"].includes((S.job || {}).state);
    const label = pages.length > 1 ? "第 " + pages[0].n + "–" + pages[pages.length - 1].n + " 页" : "第 " + pages[0].n + " 页";
    const head = bad.length ? label + "没译成功：" + PR.esc(failed[bad[0].n]) + (PR.canAsk() && !running ? '<button class="btn sm line" data-t="retry-failed">重试</button>' : "")
      : label + (running ? "还在排队翻译" : "还没有译文") + "，先放原页。";
    return '<div class="pending-pages gap"><div class="pending' + (bad.length ? " bad" : "") + '">' + head + "</div>" + pages.map(origFig).join("") + "</div>";
  }

  function pendingHtml(lastPage) {
    const m = S.paper.meta || {};
    const done = new Set((S.paper.translation || {}).done_pages || []);
    const miss = (m.pages || []).filter((p) => !done.has(p.n) && p.n > lastPage);
    if (!(m.pages || []).length) return m.text_status==='original' || (S.paper.blocks||[]).length ? '' : '<div class="pending"><span class="spin"></span> 正在渲染原页、抽取文字…</div>';
    if (!miss.length) return "";
    const job = S.job || {};
    const running = ["queued", "running"].includes(job.state);
    const nFailed = miss.filter((p) => failedOf()[p.n]).length;
    const head = running ? '<span class="spin"></span> ' + PR.esc(job.message || "翻译中") + (job.total ? "（" + job.done + "/" + job.total + " 页）" : "") + '<span class="hint">译好的页会自动出现在这里</span>'
      : "下面 " + miss.length + " 页还没有译文，先放原页。" + (nFailed ? "其中 " + nFailed + " 页上次没译成功。" : "") +
        (PR.canAsk() ? '<button class="btn sm line" data-t="translate-rest">翻译剩下的页</button>' : "");
    return '<div class="pending-pages"><div class="pending">' + head + "</div>" + miss.map(origFig).join("") + "</div>";
  }

  PR.paperHtml = function (forPrint = false) {
    buildIndex();
    let html = headHtml(), appendixSeen = false, lastPage = 0, refsSeen=false;
    const done = new Set((S.paper.translation || {}).done_pages || []);
    const allPages = (S.paper.meta || {}).pages || [];
    for (const b of S.paper.blocks || []) {
      if (!R[b.type] || (forPrint && b.type === "note")) continue;
      if(b.type==='references'){if(refsSeen)continue;refsSeen=true;}
      if (b.page && b.page > lastPage + 1) {
        const gap = allPages.filter((p) => p.n > lastPage && p.n < b.page && !done.has(p.n));
        if (gap.length) html += gapHtml(gap);
      }
      let extra = "";
      if (b.appendix && !appendixSeen) { extra = " appendix-start"; appendixSeen = true; }
      const mark = b.page && b.page > lastPage;
      if (b.page) lastPage = Math.max(lastPage, b.page);
      html += sectionHtml(b, extra, mark);
    }
    if(!refsSeen && (S.paper.references||[]).length)html+=sectionHtml({id:'folio-references',type:'references'},'',false);
    return html + pendingHtml(lastPage);
  };

  PR.renderPaper = function () {
    PR.$("#paper").innerHTML = PR.paperHtml();
    PR.emit("rendered");
  };

  /* 只重排一个块（编辑保存后用），不动别的块 */
  PR.renderBlock = function (id) {
    const b = PR.blockById[id];
    const node = document.getElementById("b-" + id);
    if (!b || !node || !R[b.type]) return;
    const fresh = document.createElement("div");
    fresh.innerHTML = sectionHtml(b, node.classList.contains("appendix-start") ? " appendix-start" : "", !!node.querySelector(":scope > .pgmark"));
    const nn = fresh.firstChild;
    ["show-en", "notes-open", "current"].forEach((c) => node.classList.contains(c) && nn.classList.add(c));
    node.replaceWith(nn);
    PR.emit("block-rendered", id);
  };

  /* 版心放不下的长公式、宽表格：先缩小字号，再不行才横向滚动 */
  PR.fitWide = function (scope) {
    // 先全部复原、再一起量、最后一起改：边改边量会让浏览器每个公式都重排一次整页
    const boxes = PR.$$(".math-body, .tbl-wrap", scope || PR.$("#paper")).filter((box) => box.firstElementChild);
    boxes.forEach((box) => { box.firstElementChild.style.fontSize = ""; });
    const sizes = boxes.map((box) => [box.clientWidth, box.firstElementChild.scrollWidth]);
    const floor = window.innerWidth < 760 ? 0.58 : 0.72;
    boxes.forEach((box, i) => {
      const [avail, need] = sizes[i];
      if (need <= avail + 1) return;
      const r = Math.max(floor, avail / need) * 0.99;
      box.firstElementChild.style.fontSize = box.classList.contains("tbl-wrap") ? (0.86 * r).toFixed(3) + "em" : (r * 100).toFixed(1) + "%";
    });
  };
  PR.on("rendered", () => PR.fitWide());
  PR.on("block-rendered", (id) => PR.fitWide(document.getElementById("b-" + id)));

  /* 保持阅读位置不动地整页重排 */
  PR.rerenderKeepingPlace = function () {
    const anchor = PR.readingBlock && PR.readingBlock();
    const node = anchor && document.getElementById("b-" + anchor);
    const before = node ? node.getBoundingClientRect().top : 0;
    PR.renderPaper();
    const after = anchor && document.getElementById("b-" + anchor);
    if (after) window.scrollBy(0, after.getBoundingClientRect().top - before);
  };
})(window.PR);
