/* 文献库右侧详情：元数据编辑、标签、状态、翻译任务、引用、删除。 */
(function (PR) {
  "use strict";
  const L = PR.lib;

  let citationAssets;
  const getAssets=()=>citationAssets||(citationAssets=Promise.all(['apa.csl','gb.csl','locales-en-US.xml','locales-zh-CN.xml'].map(name=>fetch('/web/vendor/csl/'+name).then(r=>{if(!r.ok)throw new Error('引用模板加载失败');return r.text();}))).then(([apa,gb,en,zh])=>({apa,gb,en,zh})).catch(e=>{citationAssets=null;throw e;}));
  let citationRun=0;
  PR.copyCitation=async function(i,style){
    const run=++citationRun;PR.showText('复制引用','正在核对 DOI 书目…');
    const dlg=PR.$('#textDlg'),box=dlg.querySelector('.dialog');
    try{
      const [record,assets]=await Promise.all([PR.api('/api/p/'+encodeURIComponent(i.id)+'/citation'),getAssets()]);
      if(run!==citationRun||!dlg.classList.contains('open'))return;
      let rendered;
      box.innerHTML='<h2>复制引用</h2><select class="input" id="citationStyle"><option value="gb">GB/T 7714—2015</option><option value="apa">APA 第 7 版</option><option value="bibtex">BibTeX</option></select><p class="hint">书目来源：'+PR.esc(record.source)+'</p>'+record.warnings.map(w=>'<p class="citation-warning">'+PR.esc(w)+'</p>').join('')+'<pre class="citation-preview" tabindex="0"></pre><p class="hint">引文使用原始出版题名。APA 复制到 Word 等支持格式的编辑器时保留斜体。</p><p class="hint citation-credit">Citation processing: <a href="https://citeproc-js.readthedocs.io/" target="_blank" rel="noopener">citeproc-js</a> · © 2009–2019 Frank Bennett · <a href="/web/vendor/csl/NOTICE.md" target="_blank">CSL 模板与许可</a></p><div class="actions"><button class="btn" data-close>关闭</button><button class="btn accent" id="citationCopy">复制</button></div>';
      const select=box.querySelector('#citationStyle');select.value=style;
      function draw(){rendered=window.FolioBibliography.format(record.item,select.value,assets);box.querySelector('.citation-preview').textContent=rendered.text;}
      select.onchange=draw;draw();select.focus();
      box.querySelector('#citationCopy').onclick=async()=>{
        try{
          if(select.value==='apa'&&navigator.clipboard?.write&&window.ClipboardItem){
            try{await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([rendered.text],{type:'text/plain'}),'text/html':new Blob([rendered.html],{type:'text/html'})})]);}
            catch(_){if(!await PR.copyText(rendered.text))return;}
          }else if(!await PR.copyText(rendered.text))return;
          PR.toast('引用已复制'+(record.warnings.length?'，请留意书目提示':''));
        }catch(e){PR.toast('复制失败，可直接选中上方引用复制');}
      };
    }catch(e){if(run===citationRun&&dlg.classList.contains('open'))PR.showText('引用暂时无法生成',e.message);}
  };
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); PR.toast("已复制" + what); }
    catch (e) { PR.toast("复制失败，请手动选中"); }
  }


  function jobHtml(i) {
    const j = i.job || {};
    const running = ["queued", "running"].includes(j.state);
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    let h = '<div class="jobbox">';
    if (running) {
      h += '<div><span class="spin"></span> ' + PR.esc(j.message || "处理中") + (j.total ? "（" + j.done + "/" + j.total + " 页）" : "") + "</div>" +
        '<div class="bar"><i style="width:' + pct + '%"></i></div><div class="row2"><button class="btn sm line" data-d="cancel">取消</button>' +
        '<button class="btn sm" data-d="read">边译边读</button></div>';
    } else {
      const full = i.pages && i.done_pages >= i.pages;
      h += "<div>译文：" + (i.pages ? i.done_pages + " / " + i.pages + " 页" : "尚未处理") + (full ? " · 全文" : "") + "</div>";
      const failed = Object.keys(j.failed || {}).map(Number).sort((a, b) => a - b);
      if (j.state === "error") h += '<div class="err">上次翻译出错：' + PR.esc(j.error || j.message) + "</div>";
      if (j.state === "partial" && failed.length) h += '<div class="err">第 ' + PR.esc(pageList(failed)) + " 页没译成功：" + PR.esc(j.error || "") + "</div>";
      h += '<div class="row2" style="margin-top:8px">' +
        (j.state === "partial" && failed.length ? '<button class="btn sm accent" data-d="retry-failed">重试这 ' + failed.length + " 页</button>" : "") +
        (!full && !(j.state === "partial" && failed.length) ? '<button class="btn sm accent" data-d="translate">' + (i.done_pages ? "继续翻译剩下的页" : "开始翻译") + "</button>" : "") +
        (!full && j.state === "partial" && failed.length && i.pages - i.done_pages > failed.length ? '<button class="btn sm line" data-d="translate">继续翻译剩下的页</button>' : "") +
        (j.state ? '<button class="btn sm" data-d="log">' + PR.icon("log", "sm") + "翻译记录</button>" : "") + "</div>" +
        (L.engine === "none" ? '<div class="hint" style="margin-top:6px">当前没有开启翻译引擎，去设置里选一个。</div>' : "");
    }
    return h + "</div>";
  }

  function pageList(ns) { // [3,4,5,9] → "3–5、9"
    const out = [];
    ns.forEach((n) => { const r = out[out.length - 1]; if (r && n === r[1] + 1) r[1] = n; else out.push([n, n]); });
    return out.map(([a, b]) => (a === b ? a : a + "–" + b)).join("、");
  }

  PR.renderDetail = function () {
    const box = PR.$("#detail");
    const i = L.byId(L.selected);
    if (!i) { box.innerHTML = ""; return; }
    if (box.contains(document.activeElement) && document.activeElement.matches("[contenteditable], input")) return; // 正在编辑，不打断
    const thumb = i.thumb ? '<div class="thumb" style="background-image:url(' + i.thumb + ')"></div>' : '<div class="thumb blank">' + PR.icon("pdf") + "</div>";
    const readLabel = i.progress > 0.02 ? "继续阅读 · " + Math.round(i.progress * 100) + "%" : "开始阅读";
    const status = [["unread", "未读"], ["reading", "在读"], ["done", "已读"]].map(([k, l]) =>
      '<button data-status="' + k + '" class="' + ((i.status || "unread") === k ? "on" : "") + '">' + l + "</button>").join("");
    // 标签：全部标签都列出来，点一下放进 / 拿出
    const cats = L.cats().map((c) => '<button class="catchip' + ((i.tags || []).includes(c) ? " on" : "") + '" data-cattoggle="' + PR.esc(c) + '">' + PR.icon((i.tags || []).includes(c) ? "check" : "folder", "sm") + PR.esc(c) + "</button>").join("");
    box.innerHTML = '<div class="detail-head"><span>论文详情</span><button class="detail-close" data-d="close" title="收起（Esc）">' + PR.icon("x", "sm") + "</button></div>" +
      '<div class="detail-inner">' +
      '<div class="cover">' + thumb + '<div class="actions">' +
      '<a class="btn accent" href="/read/' + i.id + '">' + PR.icon("book", "sm") + readLabel + "</a>" +
      '<a class="btn line" href="/p/' + i.id + '/source.pdf" target="_blank" rel="noopener">' + PR.icon("pdf", "sm") + "打开原 PDF</a>" +
      '<a class="btn line" href="/api/p/' + encodeURIComponent(i.id) + '/pdf" download title="' + PR.esc(i.pdf_filename || '') + '">' + PR.icon('download', 'sm') + '下载原 PDF</a>' +
      '<div class="act-row"><button class="btn line" data-d="cite" title="复制参考文献格式：GB/T 7714、APA、BibTeX">' + PR.icon("copy", "sm") + "复制引用</button>" +
      '<button class="btn icon line" data-d="star" title="星标（S）" style="color:' + (i.starred ? "#c9a24a" : "") + '">' + PR.icon("star", "sm").replace('class="i sm"', 'class="i sm"' + (i.starred ? ' style="fill:currentColor"' : "")) + "</button>" +
      '<button class="btn icon line" data-d="more" title="更多：导出、打开文件夹">' + PR.icon("more", "sm") + '</button></div>' +
      '<button class="btn line danger" data-d="delete">' + PR.icon('trash', 'sm') + '删除论文</button></div></div>' +
      '<div class="title-zh naming-display">' + PR.esc(i.display_title || i.title_zh || i.title_en || "（未命名）") + '</div>' +
      '<div class="naming-detail"><button class="btn sm line" data-name-paper="' + PR.esc(i.id) + '">' + PR.icon('edit', 'sm') + '中文命名</button>' +
      (i.naming?.source ? '<span class="hint">' + PR.esc(L.namingSourceLabel ? L.namingSourceLabel(i.naming.source) : i.naming.source) + '</span>' : '') + '</div>' +
      (i.pdf_filename ? '<p class="hint naming-filename">下载文件名：' + PR.esc(i.pdf_filename) + '</p>' : '') +
      '<details class="naming-metadata" open><summary>原标题与书目元数据</summary><label>原中文标题</label>' +
      '<div class="title-zh" contenteditable="plaintext-only" data-meta="title_zh" spellcheck="false">' + PR.esc(i.title_zh || "") + "</div><label>原文标题</label>" +
      '<div class="title-en" contenteditable="plaintext-only" data-meta="title_en" lang="en" spellcheck="false">' + PR.esc(i.title_en || "") + "</div></details>" +
      (L.organizationDetail ? L.organizationDetail(i) : '') + '<div class="cats">' + cats + '<input id="catInput" placeholder="＋ 新标签" maxlength="30"></div>' +
      '<div class="seg">' + status + "</div>" +
      '<div class="kv"><span>作者</span><span contenteditable="plaintext-only" data-meta="authors">' + PR.esc(i.authors) + "</span>" +
      '<span>年份</span><span contenteditable="plaintext-only" data-meta="year">' + PR.esc(i.year) + "</span>" +
      '<span>出处</span><span contenteditable="plaintext-only" data-meta="venue">' + PR.esc(i.venue || i.arxiv) + "</span>" +
      '<span>链接</span><span contenteditable="plaintext-only" data-meta="url">' + PR.esc(i.url) + "</span>" +
      "<span>添加</span><span>" + PR.esc(PR.relTime(i.added)) + (i.last_opened ? "　·　上次打开 " + PR.esc(PR.relTime(i.last_opened)) : "") + "</span></div>" +
      '<details class="citation-metadata"><summary>引用书目补充（缺失时填写）</summary>'+[['volume','卷号'],['issue','期号'],['citation_pages','出版页码（如 101–109）'],['article_number','文章号（如 e2024001）']].map(([k,label])=>'<label>'+label+'</label><div contenteditable="plaintext-only" class="title-en" data-meta="'+k+'">'+PR.esc(i[k]||'')+'</div>').join('')+'</details>' +
      window.FolioJournal.panel(i,i.id,true) + "<h4>翻译</h4>" + jobHtml(i) +
      (i.notes + i.highlights + i.open_questions ? '<p class="mine-line">' + [i.notes && i.notes + " 条笔记", i.highlights && i.highlights + " 处划线", i.open_questions && i.open_questions + " 个问题待回答"].filter(Boolean).join(" · ") + "</p>" : "") +
      (i.abstract ? '<h4>摘要</h4><div class="abstract" id="abs">' + PR.esc(i.abstract.replace(/\$([^$]+)\$/g, "$1")) + '</div><button class="linkish" data-d="abs">展开全文</button>' : "") +
      "</div>";
  };

  async function saveMeta(el) {
    const i = L.byId(L.selected);
    const key = el.dataset.meta, val = el.textContent.trim();
    if ((i[key] || "") === val) return;
    const override = Object.assign({}, { [key]: val });
    await L.patch(i.id, { meta_override: Object.assign({}, i.meta_override || {}, override) });
  }

  const box = PR.$("#detail");
  box.addEventListener("focusout", (e) => { if (e.target.matches("[data-meta]")) saveMeta(e.target); });
  box.addEventListener("keydown", (e) => {
    if (e.target.matches("[data-meta]") && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    if (e.target.id === "catInput" && e.key === "Enter") { L.addCat(e.target.value, L.selected); e.target.value = ""; }
  });
  box.addEventListener("click", async (e) => {
    const i = L.byId(L.selected);
    if (!i) return;
    const st = e.target.closest("[data-status]");
    if (st) return L.patch(i.id, { status: st.dataset.status });
    const ct = e.target.closest("[data-cattoggle]");
    if (ct) return L.toggleInCat(i.id, ct.dataset.cattoggle);
    const d = e.target.closest("[data-d]");
    if (!d) return;
    const act = d.dataset.d;
    if (act === "close") L.select(null);
    else if (act === "star") L.patch(i.id, { starred: !i.starred });
    else if (act === "read") L.openReader(i.id);
    else if (act === "abs") { PR.$("#abs").classList.toggle("open"); d.textContent = PR.$("#abs").classList.contains("open") ? "收起" : "展开全文"; }
    else if (act === "cite") PR.menu(d, [
      { label: "GB/T 7714—2015", icon: "copy", fn: () => PR.copyCitation(i, "gb") },
      { label: "APA 第 7 版", icon: "copy", fn: () => PR.copyCitation(i, "apa") },
      { label: "BibTeX · LaTeX / Overleaf、Zotero 导入", icon: "copy", fn: () => PR.copyCitation(i, "bibtex") },
      "-",
      { label: "标题 + 链接 · 发给别人", icon: "link", fn: () => copy((i.title_zh ? i.title_zh + "（" + i.title_en + "）" : i.title_en) + "\n" + (i.url || ""), "标题和链接") },
    ]);
    else if (act === "more") PR.rowMenu(i.id, d);
    else if (act === 'delete') L.deletePapers([i.id], d);
    else if (act === "cancel") { await PR.api("/api/p/" + i.id + "/cancel", { method: "POST", body: {} }); L.load(); }
    else if (act === "retry-failed") { await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { failed: true } }); PR.toast("正在重试"); L.load(); }
    else if (act === "log") { const r = await PR.api("/api/p/" + i.id + "/log"); PR.showText("翻译记录", r.text); }
    else if (act === "translate") { await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: {} }); PR.toast("已开始翻译"); L.load(); }
  });
  async function retranslateAll(i) {
    if (!(await PR.confirm({ title: "全部重新翻译？", body: "会消耗模型额度。你改过的译文、笔记都保留。", ok: "重新翻译" }))) return;
    await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { pages: "1-" + i.pages } });
    PR.toast("已开始重新翻译"); L.load();
  }

  PR.rowMenu = function (id, where) {
    const i = L.byId(id);
    const setStatus = (s) => () => L.patch(id, { status: s });
    PR.menu(where, [
      { label: "打开阅读", icon: "book", kbd: "Enter", fn: () => L.openReader(id) },
      { label: "打开原 PDF", icon: "pdf", fn: () => window.open("/p/" + id + "/source.pdf") },
      { label: "下载原 PDF（使用显示名称）", icon: "download", fn: () => { location.href = "/api/p/" + encodeURIComponent(id) + "/pdf"; } },
      { label: "中文命名 / 编辑下载名", icon: "edit", fn: () => L.openNaming([id]) },
      "-",
      { label: i.starred ? "取消星标" : "加星标", icon: "star", kbd: "S", fn: () => L.patch(id, { starred: !i.starred }) },
      { label: L.side.pinned.includes("p:" + id) ? "取消置顶" : "置顶到侧栏", icon: "pin", fn: () => L.togglePin("p:" + id) },
      "-",
      { label: "移动文件夹 / 编辑标签", icon: "folder", fn: () => L.openOrganization([id]) },
      ...L.catMenuItems(id),
      { label: "标为未读", fn: setStatus("unread") }, { label: "标为在读", fn: setStatus("reading") }, { label: "标为已读", fn: setStatus("done") },
      "-",
      { label: "复制 BibTeX", icon: "copy", fn: () => PR.copyCitation(i, "bibtex") },
      { label: "导出离线 HTML（可发给别人）", icon: "download", fn: () => { PR.toast("正在打包…"); location.href = "/api/p/" + id + "/export"; } },
      { label: "打开所在文件夹", icon: "folder", fn: () => PR.api("/api/p/" + id + "/reveal", { method: "POST", body: {} }).catch((e) => PR.toast(PR.esc(e.message))) },
      { label: "全部重新翻译", icon: "redo", fn: () => retranslateAll(i) },
      { label: "翻译记录", icon: "log", fn: async () => { const r = await PR.api("/api/p/" + id + "/log"); PR.showText("翻译记录", r.text); } },
      { label: '删除论文 · 移到回收站', icon: 'trash', kbd: 'Delete', fn: () => L.deletePapers([id], where) },
    ]);
  };
})(window.PR);
