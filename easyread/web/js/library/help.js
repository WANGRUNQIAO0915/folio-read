/* 帮助：快捷键、怎么用、关于。按 ? 或点顶栏问号打开。 */
(function (PR) {
  "use strict";
  const dlg = PR.$("#textDlg");
  const K = (keys, what) => "<tr><td>" + keys.split(" ").map((k) => "<kbd>" + k + "</kbd>").join(" ") + "</td><td>" + what + "</td></tr>";

  PR.openHelp = function () {
    dlg.querySelector(".dialog").innerHTML =
      '<div class="help-head">' + PR.logo("hero sm") + "<div><h2>Folio Read</h2><div class=\"hint\">版本 " + PR.esc(PR.lib.version || "") + " · 本地运行，论文与笔记可选择同步到自己的云盘</div></div></div>" +
      '<div class="help-cols"><div><h4>文献库</h4><table class="keys">' +
      K("/", "搜索") + K("J K", "上下移动") + K("Enter", "打开阅读") + K("S", "星标") + K("Delete", "删除选中论文（确认后移入回收站）") + K("Ctrl+V", "粘贴链接直接导入") + K("?", "这个帮助") +
      "</table><h4>导入</h4><p class=\"hint\">拖 PDF 进窗口；或填 arXiv 编号、DOI、论文标题、论文网页（arXiv、OpenReview、ACL、NeurIPS、bioRxiv、PMC、期刊页面）或 PDF 直链。找不到公开 PDF 的，下载后拖进来。长论文可以只译正文。</p>" +
      "<h4>翻译引擎</h4><p class=\"hint\">本机装了 Claude Code 或 Codex 就能直接用，不用 Key；也可以用 DeepSeek、智谱、通义、Gemini 等 API，或本机 Ollama。在设置里换。</p></div>" +
      '<div><h4>阅读页</h4><table class="keys">' +
      K("J K", "下一段 / 上一段") + K("N Q", "给当前段写笔记 / 提问") + K("A", "问 AI（带当前段）") + K("E", "改译文") + K("R", "让模型重译这段") +
      K("B", "译文 / 对照原文") + K("O", "原文页面板") + K("M", "笔记面板") + K("T", "目录") + K("= - 0", "字号大 / 小 / 默认") + K("1 2 3 4", "选中文字后四色划线") +
      "</table></div></div>" +
      '<div class="actions"><button class="btn" data-close>关闭</button></div>';
    dlg.classList.add("open");
  };
  PR.$("#helpBtn").onclick = PR.openHelp;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "?" || e.target.closest("input, textarea, select, [contenteditable]") || PR.$(".dialog-backdrop.open")) return;
    e.preventDefault();
    PR.openHelp();
  });
})(window.PR);
