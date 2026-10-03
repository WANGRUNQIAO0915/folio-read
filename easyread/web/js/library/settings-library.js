/* 设置 → 侧边栏：管理文献库左侧栏里的分类。
   内置分类和自建分类用同一种行：开关决定在侧栏显示还是隐藏，图钉按钮置顶；自建分类还能改名、删除。
   “全部”始终显示。改动立刻生效（和在侧栏右键操作一样），不用等“保存”。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const BUILTIN = [["reading", "在读"], ["unread", "未读"], ["done", "已读"], ["starred", "星标"],
    ["questions", "有待回答的问题", "有问题没回答时才出现"], ["translating", "翻译中", "有论文在翻译时才出现"]];

  function row(o) {  // o: {name, sub, pinKey, hideKey, custom, fixed}
    const pinned = o.pinKey && L.side.pinned.includes(o.pinKey);
    if (o.renaming) return '<div class="sb-row"><input class="input" id="libRenameInput" value="' + PR.esc(o.name) + '" maxlength="30"><button class="btn sm accent" data-lib="rename-ok" data-c="' + PR.esc(o.name) + '">好</button><button class="btn sm" data-lib="cancel">取消</button></div>';
    return '<div class="sb-row"><span class="sb-name">' + PR.icon(o.custom ? "folder" : "book", "sm") + "<b>" + PR.esc(o.name) + "</b>" + (o.sub ? "<small>" + PR.esc(o.sub) + "</small>" : "") + "</span>" +
      (o.custom ? '<button class="btn sm" data-lib="rename" data-c="' + PR.esc(o.name) + '">改名</button><button class="btn sm danger" data-lib="del" data-c="' + PR.esc(o.name) + '">删除</button>' : "") +
      (o.pinKey ? '<button class="sb-pin' + (pinned ? " on" : "") + '" data-lib="pin" data-key="' + PR.esc(o.pinKey) + '" title="' + (pinned ? "取消置顶" : "置顶到侧栏最上面") + '">' + PR.icon("pin", "sm") + "</button>" : '<span class="sb-pin-space"></span>') +
      '<input type="checkbox" class="switch" title="在侧栏显示"' + (o.fixed ? " checked disabled" : ' data-libshow="' + PR.esc(o.hideKey) + '"' + (L.side.hidden.includes(o.hideKey) ? "" : " checked")) + "></div>";
  }

  PR.settingsTabs.library = {
    render(s) {
      const count = (fn) => L.items.filter(fn).length;
      const cats = L.cats();
      return '<p class="set-lead">文献库左侧栏里显示哪些分类。开关控制显示或隐藏，图钉是置顶。一篇论文可以放进好几个分类：在论文上右键，或者把它拖到侧栏的分类上。改动立刻生效。</p>' +
        '<h4 class="set-h">内置分类</h4><div class="sb-list">' +
        row({ name: "全部", sub: "始终显示", fixed: true }) +
        BUILTIN.map(([k, name, note]) => row({ name, sub: note || count((L.VIEWS.find((v) => v[0] === k) || [])[3] || (() => false)) + " 篇", pinKey: "v:" + k, hideKey: k })).join("") + "</div>" +
        '<h4 class="set-h">我的分类</h4><div class="sb-list">' +
        (cats.map((c) => row({ name: c, sub: count((x) => (x.tags || []).includes(c)) + " 篇", pinKey: "c:" + c, hideKey: "c:" + c, custom: true, renaming: s.libRename === c })).join("") || '<p class="hint">还没有自建分类。</p>') +
        '</div><div class="cm-form-acts" style="margin-top:10px"><input class="input" id="libNewInput" placeholder="新分类的名字" maxlength="30" style="max-width:240px"><button class="btn sm line" data-lib="add">' + PR.icon("plus", "sm") + "新建分类</button></div>";
    },
    async click(e, s) {
      const b = e.target.closest("[data-lib]");
      if (!b) return false;
      const c = b.dataset.c, act = b.dataset.lib;
      if (act === "add") L.addCat(PR.$("#libNewInput").value);
      if (act === "pin") L.togglePin(b.dataset.key);
      if (act === "rename") s.libRename = c;
      if (act === "cancel") s.libRename = null;
      if (act === "rename-ok") { L.renameCat(c, PR.$("#libRenameInput").value); s.libRename = null; }
      if (act === "del") await L.deleteCat(c, b);
      return true;
    },
    change(e) {
      if (e.target.dataset.libshow) L.setHidden(e.target.dataset.libshow, !e.target.checked);
      return false;
    },
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.id === "libNewInput") { e.preventDefault(); PR.$('[data-lib="add"]').click(); }
    if (e.target.id === "libRenameInput") { e.preventDefault(); PR.$('[data-lib="rename-ok"]').click(); }
  }, true);
})(window.PR);
