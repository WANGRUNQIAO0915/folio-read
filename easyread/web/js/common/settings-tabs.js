/* 设置的另外两页：阅读（功能开关、主题）、快捷键（总开关、改键）。 */
(function (PR) {
  "use strict";
  const T = PR.settingsTabs;

  /* ---------- 阅读 ---------- */
  T.reading = {
    render(s) {
      return '<p class="set-lead">阅读页上显示哪些功能。关掉的功能，按钮和快捷键都会一起消失。</p><div class="switch-list">' +
        PR.FEATURES.map(([id, name, , desc]) => '<label class="switch-row"><span><b>' + name + "</b><small>" + desc + '</small></span><input type="checkbox" class="switch" data-feat="' + id + '"' + (s.ui.features[id] !== false ? " checked" : "") + "></label>").join("") +
        "</div>" + '<div class="settings-sec grid2"><label class="field"><span>界面主题</span><select class="input" id="themeSel">' +
        PR.opt([["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"]], s.theme) + "</select></label></div>" +
        '<p class="hint">Absolutely 配色：暖白或炭灰背景，陶土橙强调色。</p>' +
        '<p class="hint">字号、版心、行距在阅读页右上角的 Aa 里调。</p>';
    },
    change(e, s) {
      if (e.target.dataset.feat) s.ui.features[e.target.dataset.feat] = e.target.checked;
      if (e.target.id === "themeSel") { s.theme = e.target.value; PR.applyTheme(s.theme); }
      return false;
    },
  };

  /* ---------- 快捷键 ---------- */
  T.keys = {
    render(s) {
      let h = '<label class="switch-row big"><span><b>启用快捷键</b><small>关掉后只剩 Esc。单个字母的快捷键打字时不会触发，但点着页面时按到会触发。</small></span><input type="checkbox" class="switch" id="keysOn"' + (s.ui.keys_on ? " checked" : "") + "></label>";
      h += '<div class="keys-list' + (s.ui.keys_on ? "" : " dim") + '">';
      let grp = "";
      for (const [id, label, , group, need] of PR.KEY_ACTIONS) {
        if (group !== grp) { h += '<div class="grp">' + group + "</div>"; grp = group; }
        const off = need && s.ui.features[need] === false;
        const k = s.ui.keys[id];
        h += "<span>" + label + (off ? ' <small class="hint">（功能已关）</small>' : "") + '</span><button class="kcap' + (s.recording === id ? " rec" : k ? "" : " off") + '" data-krec="' + id + '">' +
          (s.recording === id ? "按一个键…" : k ? PR.esc(PR.keyName(k)) : "未设置") + '</button><button class="kx" data-koff="' + id + '" title="不用这个快捷键">清除</button>';
      }
      return h + '</div><div class="keys-foot"><span class="hint">选中文字后 1–4 四色划线、N 笔记、Q 提问，跟着总开关。</span><button class="btn sm" data-kreset>恢复默认键位</button></div>';
    },
    click(e, s) {
      const r = e.target.closest("[data-krec]"), off = e.target.closest("[data-koff]");
      if (r) { s.recording = s.recording === r.dataset.krec ? null : r.dataset.krec; return true; }
      if (off) { s.ui.keys[off.dataset.koff] = ""; s.recording = null; return true; }
      if (e.target.closest("[data-kreset]")) { s.ui.keys = PR.defaultKeys(); s.recording = null; return true; }
      return false;
    },
    change(e, s) { if (e.target.id === "keysOn") { s.ui.keys_on = e.target.checked; return true; } return false; },
    key(e, s) {
      if (e.key === "Escape") { s.recording = null; return true; }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return false;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (/^[1-4]$/.test(k)) { PR.toast("1–4 留给选中文字后的划线"); return false; }
      const taken = Object.keys(s.ui.keys).find((id) => s.ui.keys[id] === k && id !== s.recording);
      if (taken) { s.ui.keys[taken] = ""; PR.toast("「" + PR.KEY_ACTIONS.find((a) => a[0] === taken)[1] + "」原来的键让给了这个操作"); }
      s.ui.keys[s.recording] = k;
      s.recording = null;
      return true;
    },
  };
})(window.PR);
