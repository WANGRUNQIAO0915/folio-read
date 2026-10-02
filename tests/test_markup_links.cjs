const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const context = {URL, window:{PR:{esc:escape, refById:{'1':{}}, xindex:{fig:{'2':'fig2'}}}},
  katex:{renderToString:tex => '<math>'+escape(tex)+'</math>'}};
vm.runInNewContext(fs.readFileSync('easyread/web/js/common/markup.js','utf8'), context);
const md = context.window.PR.md;
let html = md('请访问 [数据网站](https://example.org/data_(v2)?a=1&b=2)，以及 https://example.org/article。');
assert.match(html, /href="https:\/\/example.org\/data_\(v2\)\?a=1&amp;b=2"/);
assert.match(html, />数据网站<\/a>/);
assert.match(html, /href="https:\/\/example.org\/article"/);
assert.match(html, /rel="noopener noreferrer"/);
assert.match(md('www.example.org，DOI: 10.1234/abcd.ef；mailto:author@example.org'), /href="https:\/\/doi.org\/10.1234\/abcd.ef"/);
assert.match(md('[作者邮箱](mailto:author@example.org)'), /href="mailto:author@example.org"/);
assert.match(md('[1](https://example.org) [1] 图 2'), />1<\/a>.*class="cite".*class="xref"/);
assert.equal((md('`https://example.org` 与 $x^2$').match(/<a /g)||[]).length,0);
assert.match(md('`https://example.org` 与 $x^2$'), /<code>https:\/\/example.org<\/code>.*<math>x\^2<\/math>/);
assert.match(md('https://example.org/?a=$hello$'), /href="https:\/\/example.org\/\?a=\$hello\$"/);
for(const url of ['javascript:alert(1)','data:text/html,hi','file:///C:/secret','https://user:password@example.org']) {
  assert.doesNotMatch(md('[网站]('+url+')'), /<a /);
}
assert.doesNotMatch(md('[<img src=x onerror=alert(1)>](https://example.org)'), /<img/);
assert.match(md('**[链接](https://example.org)**'), /<strong><a /);
assert.match(md('见 https://example.org/paper_(v2).'), /href="https:\/\/example.org\/paper_\(v2\)"/);
assert.match(md('将“https://example.org/paper”标注为网址（www.example.org）。'), /href="https:\/\/example.org\/paper"[^>]*>https:\/\/example.org\/paper<\/a>”标注为/);
const printed = 'www.nature.com/articles/s41559−023−02206−6#Sec23';
assert.match(md('数据：https://' + printed, {sourceLinks: [{label: printed, url:'https://www.nature.com/articles/s41559-023-02206-6'}]}), /href="https:\/\/www.nature.com\/articles\/s41559-023-02206-6"/);
assert.match(md('https://example.org/data', {sourceLinks: [{label:'https://example.org/data',url:'https://example.org/one'}, {label:'https://example.org/data',url:'https://example.org/two'}]}), /href="https:\/\/example.org\/data"/);
console.log('Translation link, math/citation and protocol regression checks passed.');
