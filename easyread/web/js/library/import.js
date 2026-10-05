/* 导入：对话框（选文件 / 链接）+ 把 PDF 拖进窗口任何地方 + 在页面上直接粘贴链接。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const dlg = PR.$("#importDlg");
  let importingFiles = false, importingRef = false;
  const SCOPES = [["all", "全文"], ["body", "正文（到参考文献为止）"], ["first", "前几页"]];

  const pref = () => Object.assign({ auto: true, scope: "all", first: 10 }, PR.ls.get("easyread-import", {}));
  const savePref = (p) => PR.ls.set("easyread-import", Object.assign(pref(), p));

  PR.openImport = function (ref) {
    const p = pref();
    const off = L.engine === "none";
    dlg.querySelector(".dialog").innerHTML =
      "<h2>导入论文</h2>" +
      '<div class="dropzone" id="pick">' + PR.icon("upload") + '<div class="big">选择 PDF，或拖到这里</div><div class="hint">可以一次选多个；同一个文件不会重复导入</div></div>' +
      '<label class="field"><span>保存到软件文件夹</span><select class="input" id="importFolder">' + L.folderOptions(L.folder || null) + '</select><small class="hint">原 PDF 不移动；已有论文不会重复导入或改动原分类。</small></label>' +
      '<div class="or">或者</div>' +
      '<label class="field"><span>链接、arXiv 编号、DOI 或论文标题</span><div class="inline"><input class="input" id="arxivRef" placeholder="2411.00640 · 10.18653/v1/N19-1423 · 论文网页链接 · 论文标题">' +
      '<button class="btn accent" id="arxivGo">导入</button></div></label>' +
      '<p class="hint">请填写完整论文标题。自动导入需要可下载的 PDF；需登录或订阅时，可在浏览器下载后选择文件导入。Windows 独立窗口也可使用顶部“文件 → 机构访问并导入 PDF”，自行认证后下载。</p>' +
      '<p class="hint" id="importRefStatus" role="status" aria-live="polite"></p>' +
      '<div class="imp-opts"><label class="check"><input type="checkbox" id="autoTr"' + (p.auto && !off ? " checked" : "") + (off ? " disabled" : "") + ">导入后翻译</label>" +
      '<div class="seg" id="scopeSeg">' + SCOPES.map(([k, l]) => '<button data-scope="' + k + '" class="' + (p.scope === k ? "on" : "") + '">' + l + "</button>").join("") + "</div>" +
      '<span class="first-n"' + (p.scope === "first" ? "" : " hidden") + '><input class="input" id="firstN" type="number" min="1" value="' + p.first + '"> 页</span></div>' +
      '<p class="hint" style="margin-top:8px">用 ' + PR.esc(L.engineLabel || "（未设置）") + ' 翻译 · <button class="linkish" id="impEngine">换引擎</button>。长论文可以先译正文，附录之后在详情里点“继续翻译”。</p>' +
      '<div class="actions"><button class="btn" id="impClose">关闭</button></div>';
    dlg.classList.add("open");
    setTimeout(() => { const i = PR.$("#arxivRef"); if (ref) i.value = ref; i.focus(); }, 50);
  };
  const close = () => dlg.classList.remove("open");
  function opts() {
    const p = pref();
    const c = PR.$("#autoTr");
    const auto = c ? c.checked : p.auto && L.engine !== "none";
    const scope = p.scope === "first" ? "first:" + Math.max(1, +p.first || 10) : p.scope;
    const folder_id = dlg.classList.contains("open") ? (PR.$("#importFolder")?.value || null) : L.folder || null;
    return { translate: auto, scope, folder_id };
  }

  dlg.addEventListener("click", (e) => {
    if (e.target === dlg || e.target.closest("#impClose")) close();
    if (e.target.closest("#pick")) PR.$("#fileInput").click();
    if (e.target.closest("#arxivGo")) importRef(PR.$("#arxivRef").value);
    if (e.target.closest("#impEngine")) { close(); PR.openSettings(); }
    const s = e.target.closest("[data-scope]");
    if (s) {
      savePref({ scope: s.dataset.scope });
      PR.$$("[data-scope]", dlg).forEach((b) => b.classList.toggle("on", b === s));
      PR.$(".first-n", dlg).hidden = s.dataset.scope !== "first";
    }
  });
  dlg.addEventListener("change", (e) => {
    if (e.target.id === "autoTr") savePref({ auto: e.target.checked });
    if (e.target.id === "firstN") savePref({ first: +e.target.value || 10 });
  });
  dlg.addEventListener("keydown", (e) => { if (e.target.id === "arxivRef" && e.key === "Enter") importRef(e.target.value); if (e.key === "Escape") close(); });
  PR.$("#importBtn").onclick = () => PR.openImport();
  PR.$("#fileInput").addEventListener("change", (e) => { importFiles(Array.from(e.target.files)); e.target.value = ""; });

  async function importFiles(files) {
    if (importingFiles) return PR.toast("正在导入，请稍候");
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) return PR.toast("只支持 PDF 文件");
    const o = opts();
    close();
    importingFiles = true;
    let last = null, added = 0, existing = 0, failed = 0;
    for (const [k, f] of pdfs.entries()) {
      PR.toast("正在导入 " + (k + 1) + "/" + pdfs.length + "：" + PR.esc(f.name), null, 60000);
      try {
        const r = await PR.api("/api/import?translate=" + (o.translate ? 1 : 0) + "&scope=" + encodeURIComponent(o.scope) + "&name=" + encodeURIComponent(f.name) + "&folder_id=" + encodeURIComponent(o.folder_id || ""), { method: "POST", body: f });
        last = r.id;
        if (r.new) added++; else existing++;
        if (!r.new) PR.toast("《" + PR.esc(f.name) + "》已经在库里了");
      } catch (e) { failed++; PR.toast("导入失败：" + PR.esc(e.message)); }
    }
    importingFiles = false;
    await L.load();
    if (last) { L.select(last); PR.toast([added ? "已导入 " + added + " 篇" + (o.translate ? "，后台开始翻译" : "") : "", existing ? existing + " 篇已在库中，分类保持不变" : "", failed ? failed + " 篇导入失败" : ""].filter(Boolean).join("；"), { label: "打开", fn: () => L.openReader(last) }, 6000); }
  }

  async function importRef(ref) {
    ref = (ref || "").trim();
    if (!ref || importingRef) return;
    importingRef = true;
    const btn = PR.$("#arxivGo");
    const status = PR.$("#importRefStatus");
    if (status) status.textContent = "正在检索论文并下载 PDF…";
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 查找中'; }
    else PR.toast('<span class="spin"></span> 正在查找并下载 ' + PR.esc(ref), null, 60000);
    const o = opts();
    try {
      const r = await PR.api("/api/import-url", { method: "POST", body: { ref, translate: o.translate, scope: o.scope, folder_id: o.folder_id } });
      close();
      await L.load();
      L.select(r.id);
      PR.toast(r.new ? "已导入" + (o.translate ? "，后台开始翻译" : "") : "这篇已经在库里了", { label: "打开", fn: () => L.openReader(r.id) }, 6000);
    } catch (e) {
      if (status) status.textContent = "导入失败：" + e.message;
      PR.toast("导入失败：" + PR.esc(e.message), null, 8000);
    } finally {
      importingRef = false;
      if (btn) { btn.disabled = false; btn.textContent = "导入"; }
    }
  }
  PR.importRef = importRef;

  /* 在文献库页面直接 Ctrl+V 一个链接或 arXiv 编号 */
  document.addEventListener("paste", (e) => {
    if (e.target.closest("input, textarea, [contenteditable]") || PR.$(".dialog-backdrop.open")) return;
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) { e.preventDefault(); return importFiles(files); }
    const t = (e.clipboardData.getData("text") || "").trim();
    if (/^(https?:\/\/\S+|(arxiv:)?\d{4}\.\d{4,5}(v\d+)?|(doi:\s*)?10\.\d{4,9}\/\S+)$/i.test(t)) { e.preventDefault(); PR.openImport(t); }
  });

  /* 拖进窗口任何地方都能导入 */
  let depth = 0;
  const overlay = PR.$("#dropOverlay");
  const hasFiles = (e) => Array.from(e.dataTransfer && e.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; overlay.classList.add("on"); });
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove("on"); });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; overlay.classList.remove("on");
    importFiles(Array.from(e.dataTransfer.files));
  });
})(window.PR);
