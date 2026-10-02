/* 导出笔记：勾选要哪些（我的笔记、划线、我的问题、AI 的回答和解释、论文笔记、问 AI 的对话），导出 Markdown。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const KINDS = [
    ["paper", "论文笔记（整篇的感悟）"], ["note", "我的笔记"], ["highlight", "我的划线"], ["question", "我的问题"],
    ["ai", "AI 的回答和解释（页边）"], ["chat", "问 AI 的对话记录"], ["quote", "每条附上原文引用"],
  ];

  function counts() {
    const notes = PR.myNotes();
    return {
      paper: (S.reader.paper_note || {}).body ? 1 : 0,
      note: notes.filter((n) => n.kind === "note" || (n.kind !== "question" && n.kind !== "highlight")).length,
      highlight: notes.filter((n) => n.kind === "highlight").length,
      question: notes.filter((n) => n.kind === "question").length,
      ai: (S.discussion.entries || []).length,
    };
  }

  PR.openExport = function () {
    const c = counts();
    const saved = PR.ls.get("easyread-export", { paper: true, note: true, highlight: true, question: true, ai: true, chat: false, quote: true });
    const dlg = PR.$("#readerDlg");
    dlg.querySelector(".dialog").innerHTML = "<h2>导出笔记</h2><div class=\"exp-opts\">" +
      KINDS.map(([k, l]) => '<label><input type="checkbox" data-exp="' + k + '"' + (saved[k] ? " checked" : "") + ">" + l +
        (c[k] != null ? '<span class="n">' + c[k] + " 条</span>" : "") + "</label>").join("") +
      '</div><p class="hint">导出成 Markdown，按原文章节顺序排，可以直接放进 Obsidian、Notion。</p>' +
      '<div class="actions"><button class="btn" data-exp-close>取消</button><button class="btn primary" data-exp-go>导出</button></div>';
    dlg.classList.add("open");
  };

  PR.$("#readerDlg").addEventListener("click", async (e) => {
    const dlg = PR.$("#readerDlg");
    if (e.target.closest("[data-exp-close]")) return dlg.classList.remove("open");
    if (!e.target.closest("[data-exp-go]")) return;
    const pick = {};
    PR.$$("[data-exp]", dlg).forEach((i) => (pick[i.dataset.exp] = i.checked));
    PR.ls.set("easyread-export", pick);
    let chat = [];
    if (pick.chat) {
      try {
        chat = PR.exportChatMessages(PR.store.mode === "server" ? await PR.api("/api/p/" + PR.pid + "/chat") : S.chat);
      } catch (err) {
        PR.toast("对话读取失败，未导出：" + PR.esc(err.message));
        return;
      }
    }
    const text = PR.notesMarkdown(pick, chat);
    const stem = ((S.paper.meta || {}).short_zh || (S.paper.meta || {}).title_zh || "论文").replace(/[\\/:*?"<>|]/g, "");
    const a = PR.el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" })), download: stem + "-笔记.md" });
    document.body.appendChild(a); a.click(); a.remove();
    dlg.classList.remove("open");
  });
})(window.PR);
