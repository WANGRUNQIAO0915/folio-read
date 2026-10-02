/* 功能开关和快捷键（文献库页、阅读页、设置共用）。
   存在本机 prefs.json：ui.features（哪些功能开着）、ui.keys_on（快捷键总开关）、keys（改过的键位）。
   浏览器 localStorage 里留一份缓存，打开页面时先用缓存，服务端的到了再以服务端为准。 */
(function (PR) {
  "use strict";

  /* [id, 名字, 默认开关, 说明] */
  PR.FEATURES = [
    ["chat", "问 AI", true, "阅读页右侧边读边问；段落操作条、选中文字、笔记卡片上的“问 AI”"],
    ["edit", "改译文", true, "段落操作条里的“改译文”（也可以双击段落）"],
    ["en", "展开英文原文", true, "段落操作条里的“原文”"],
    ["pages", "原页面板", true, "右上角“原页”，对照 PDF 原页"],
    ["retranslate", "让模型重译一段", false, "会花 token，容易误点，默认关；开了之后在段落的“⋯”菜单里"],
  ];
  /* [id, 名字, 默认键, 分组, 依赖的功能] */
  PR.KEY_ACTIONS = [
    ["next", "下一段", "j", "阅读"], ["prev", "上一段", "k", "阅读"],
    ["mode", "译文 / 对照原文", "b", "阅读"], ["toc", "目录", "t", "阅读"],
    ["fontUp", "字号变大", "=", "阅读"], ["fontDown", "字号变小", "-", "阅读"], ["fontReset", "恢复默认字号", "0", "阅读"],
    ["notes", "笔记面板", "m", "面板"], ["chat", "问 AI（带当前段）", "a", "面板", "chat"],
    ["pages", "原页面板", "o", "面板", "pages"], ["pagePrev", "原页上一页", "[", "面板", "pages"], ["pageNext", "原页下一页", "]", "面板", "pages"],
    ["note", "给当前段写笔记", "n", "当前段"], ["question", "给当前段提问", "q", "当前段"],
    ["en", "展开这段英文", "y", "当前段", "en"], ["edit", "改译文", "e", "当前段", "edit"],
    ["redo", "让模型重译这段", "", "当前段", "retranslate"],
    ["page", "看这段的原页", "p", "当前段", "pages"], ["copy", "复制这段译文", "c", "当前段"],
  ];
  const DEF_KEYS = Object.fromEntries(PR.KEY_ACTIONS.map(([id, , k]) => [id, k]));
  const DEF_FEATURES = Object.fromEntries(PR.FEATURES.map(([id, , on]) => [id, on]));

  const ui = PR.ls.get("easyread-ui", {});
  PR.features = Object.assign({}, DEF_FEATURES, ui.features || {});
  PR.keysOn = ui.keys_on !== false;
  PR.keymap = Object.assign({}, DEF_KEYS, PR.ls.get("easyread-keys", {}));

  PR.feature = (id) => PR.features[id] !== false;
  const show = (k) => (!k ? "" : k === " " ? "空格" : k.length === 1 ? k.toUpperCase() : k);
  PR.keyName = show;
  PR.keyOf = (id) => (PR.keysOn ? show(PR.keymap[id]) : "");
  PR.keyAction = function (k) {
    if (!PR.keysOn) return null;
    if (k === "+") k = "=";
    if (k === "_") k = "-";
    const a = PR.KEY_ACTIONS.find(([id, , , , need]) => PR.keymap[id] === k && (!need || PR.feature(need)));
    return a ? a[0] : null;
  };

  /* 设置页保存时调用：{features, keys_on, keys} */
  PR.applyUi = function (next, persist) {
    if (next.features) PR.features = Object.assign({}, DEF_FEATURES, next.features);
    if (next.keys_on != null) PR.keysOn = !!next.keys_on;
    if (next.keys) PR.keymap = Object.assign({}, DEF_KEYS, next.keys);
    const diff = Object.fromEntries(Object.entries(PR.keymap).filter(([id, k]) => DEF_KEYS[id] !== k));
    PR.ls.set("easyread-ui", { features: PR.features, keys_on: PR.keysOn });
    PR.ls.set("easyread-keys", diff);
    if (persist) {
      PR.savePrefs("ui", { features: PR.features, keys_on: PR.keysOn });
      PR.savePrefs("keys", Object.assign(Object.fromEntries(Object.keys(DEF_KEYS).map((id) => [id, null])), diff));
    }
    PR.emit && PR.emit("ui-changed");
  };
  PR.defaultKeys = () => Object.assign({}, DEF_KEYS);

  /* 服务端 prefs 到了之后以它为准 */
  PR.useServerUi = function (p) {
    const keys = p.keys ? Object.fromEntries(Object.entries(p.keys).filter(([, v]) => v !== null)) : null;
    PR.applyUi({ features: (p.ui || {}).features || PR.features, keys_on: (p.ui || {}).keys_on, keys: keys ? Object.assign({}, DEF_KEYS, keys) : PR.keymap }, false);
  };
})(window.PR);
