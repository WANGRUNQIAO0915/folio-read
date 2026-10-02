const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = { window: { PR: {} } };
vm.runInNewContext(fs.readFileSync("easyread/web/js/common/chat-export.js", "utf8"), context);
const flatten = context.window.PR.exportChatMessages;
const out = flatten({ threads: [
  { title: "方法", messages: [{ role: "user", content: "问题一" }, { role: "assistant", content: "回答一" }] },
  { title: "证据", messages: [{ role: "assistant", content: "回答二" }] },
] });
assert.equal(out.length, 3);
assert.equal(out[2].threadTitle, "证据");
assert.equal(out[2].threadStart, true);
assert.equal(out[1].threadStart, false);
assert.equal(flatten({ messages: [{ content: "旧记录" }] })[0].content, "旧记录");
console.log("Chat export regression checks passed.");
