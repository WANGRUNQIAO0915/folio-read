/* 正文图片放大与原页框选。图片颜色保持原样；离线版也可放大查看。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let dialog, block, mode, page, selection, start, previousFocus, saving = false;
  const pages = () => (S.paper.meta || {}).pages || [];

  function createDialog() {
    if (dialog) return;
    dialog = PR.el("dialog", { id: "figureDlg", class: "figure-dialog", "aria-labelledby": "figureDialogTitle" });
    document.body.appendChild(dialog);
    dialog.addEventListener("close", () => {
      document.body.classList.remove("figure-modal-open");
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    });
    dialog.addEventListener("cancel", (e) => { if (saving) e.preventDefault(); });
    dialog.addEventListener("keydown", (e) => e.stopPropagation());
    dialog.addEventListener("click", async (e) => {
      const control = e.target.closest("[data-fig-dialog]");
      if (!control || saving) return;
      const action = control.dataset.figDialog;
      if (action === "close") dialog.close();
      if (action === "zoom") {
        dialog.classList.toggle("natural");
        control.textContent = dialog.classList.contains("natural") ? "适合窗口" : "原始大小";
      }
      if (action === "crop") { mode = "crop"; page = block.image_page || block.page; selection = block.image_box || null; render(); }
      if (action === "reset") { selection = null; draw(); }
      if (action === "prev" || action === "next") {
        const i = pages().findIndex((p) => p.n === page), next = pages()[i + (action === "prev" ? -1 : 1)];
        if (next) { page = next.n; selection = null; render(); }
      }
      if (action === "save") await save();
    });
    dialog.addEventListener("change", (e) => {
      if (e.target.matches(".figure-page-picker")) { page = Number(e.target.value); selection = null; render(); }
    });
  }

  function open(b, view) {
    createDialog();
    block = b; mode = view; page = b.image_page || b.page;
    selection = b.image_box || null; previousFocus = document.activeElement;
    render();
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("figure-modal-open");
  }

  function render() {
    dialog.classList.remove("natural");
    const title = "图 " + (block.num || "") + " · " + (mode === "crop" ? "调整截图" : "放大查看");
    const close = '<button class="btn icon" data-fig-dialog="close" aria-label="关闭图片查看">×</button>';
    if (mode === "zoom") {
      dialog.innerHTML = '<div class="figure-dialog-head"><b id="figureDialogTitle">' + PR.esc(title) + '</b>' +
        '<button class="btn sm" data-fig-dialog="zoom">原始大小</button>' +
        (PR.store.mode === "server" ? '<button class="btn sm" data-fig-dialog="crop">调整截图</button>' : '') + close + '</div>' +
        '<div class="figure-dialog-scroll"><img class="figure-dialog-image" src="' + PR.esc(PR.imageUrl(block.src)) + '" alt="' +
        PR.esc(PR.plain(block.caption_zh || block.caption_en || "论文插图")) + '"></div>' +
        '<div class="figure-dialog-foot"><p>' + PR.esc(PR.plain(PR.textFor(block.id + "#caption"))) + '</p></div>';
      return;
    }
    const p = pages().find((p) => p.n === page) || pages()[0];
    if (!p) { PR.toast("没有可供截图的原页图"); if (dialog.open) dialog.close(); return; }
    page = p.n;
    dialog.innerHTML = '<div class="figure-dialog-head"><b id="figureDialogTitle">' + PR.esc(title) + '</b>' +
      '<button class="btn sm" data-fig-dialog="prev" aria-label="上一原页">‹</button>' +
      '<select class="figure-page-picker" aria-label="图片所在原页">' + pages().map((p) => '<option value="' + p.n + '"' + (p.n === page ? ' selected' : '') + '>第 ' + p.n + ' 页</option>').join('') + '</select>' +
      '<button class="btn sm" data-fig-dialog="next" aria-label="下一原页">›</button>' +
      '<button class="btn sm" data-fig-dialog="reset">重新框选</button>' + close + '</div>' +
      '<div class="figure-dialog-scroll"><div class="figure-crop-stage"><img src="' + PR.esc(PR.imageUrl(p.img)) +
      '" alt="原文第 ' + page + ' 页"><div class="figure-crop-box" hidden></div></div></div>' +
      '<div class="figure-dialog-foot"><p role="status">在原页上拖动框住整幅图，保留子图、图例和坐标标签，避开图注与正文。</p>' +
      '<button class="btn accent" data-fig-dialog="save" data-fig-save disabled>保存截图</button></div>';
    const stage = PR.$(".figure-crop-stage", dialog);
    const image = PR.$("img", stage);
    image.addEventListener("load", draw);
    image.addEventListener("error", () => { selection = null; draw(); status("原页图加载失败，请关闭后重试。"); });
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || saving || !image.complete || !image.naturalWidth) return;
      e.preventDefault();
      start = point(e, stage); selection = [start[0], start[1], start[0], start[1]];
      stage.setPointerCapture(e.pointerId); draw();
    });
    stage.addEventListener("pointermove", (e) => {
      if (!start || !stage.hasPointerCapture(e.pointerId)) return;
      const end = point(e, stage);
      selection = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
      draw();
    });
    stage.addEventListener("pointerup", (e) => {
      if (!start) return;
      start = null;
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      if (!valid()) selection = null;
      draw();
    });
    stage.addEventListener("pointercancel", () => { start = null; selection = null; draw(); });
    start = null; draw();
  }

  function point(e, stage) {
    const r = stage.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  }
  function valid() { return selection && selection[2] - selection[0] >= .01 && selection[3] - selection[1] >= .01; }
  function draw() {
    const rect = PR.$(".figure-crop-box", dialog), button = PR.$("[data-fig-save]", dialog), image = PR.$(".figure-crop-stage img", dialog);
    if (!rect || !button) return;
    rect.hidden = !selection;
    if (selection) Object.assign(rect.style, { left: selection[0] * 100 + "%", top: selection[1] * 100 + "%",
      width: (selection[2] - selection[0]) * 100 + "%", height: (selection[3] - selection[1]) * 100 + "%" });
    button.disabled = saving || !valid() || !image.complete || !image.naturalWidth;
  }
  function status(text) { PR.$('[role="status"]', dialog).textContent = text; }
  async function save() {
    if (!valid() || saving) return;
    saving = true; draw(); status("正在保存截图…");
    PR.$$("button, select", dialog).forEach((c) => { c.disabled = true; });
    try {
      await PR.api("/api/p/" + PR.pid + "/figure", { method: "POST", body: { id: block.id, page, box: selection } });
      await PR.poll();
      dialog.close(); PR.toast("图片已更新，截图会保存在这篇论文中");
    } catch (err) {
      status("保存失败：" + err.message);
    } finally {
      saving = false;
      PR.$$("button, select", dialog).forEach((c) => { c.disabled = false; });
      if (dialog.open) draw();
    }
  }

  document.addEventListener("click", (e) => {
    const control = e.target.closest("#paper [data-fig-act]");
    if (!control) return;
    const host = control.closest(".blk-figure"), b = host && PR.blockById[host.dataset.id];
    if (!b) return;
    const action = control.dataset.figAct;
    if (action === "zoom" && b.src) open(b, "zoom");
    if (action === "crop" && PR.store.mode === "server") open(b, "crop");
    if (action === "original") PR.openPage(b.image_page || b.page, b.id);
  });
  document.addEventListener("error", (e) => {
    if (e.target.matches && e.target.matches("#paper .figure-image img")) {
      e.target.parentElement.hidden = true;
      const fallback = PR.$(".fig-load-error", e.target.closest(".blk-figure"));
      if (fallback) fallback.hidden = false;
    }
  }, true);
})(window.PR);
