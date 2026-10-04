const assert = require('node:assert/strict');
const {build} = require('../easyread/web/js/reader/outline.js');
const heading = (id, num, zh, level = 1, page = 1, extra = {}) => ({id, num, zh, level, page, type: 'heading', ...extra});
const input = [
  heading('intro', '1', '引言'), heading('method-page', '2', '方法', 1, 2),
  heading('region-page', '2.1', '中国绿洲范围的划定', 2, 2),
  heading('method', '2', '方法', 1, 3), heading('region', '2.1', '中国绿洲范围的划定', 2, 3),
  heading('source', '2.2', '数据来源', 2, 3),
  heading('results', '3', '结果'), heading('compare', '3.3', '比较', 2),
  heading('crop', '3.3.1', '与耕地的对比', 1), heading('water', '3.3.2', '与地表水的对比', 3),
  heading('discussion', '4', '讨论'), heading('changes', '4.1', '4.1 1987–2024 年土地覆盖动态', 2),
  {id:'refs', type:'references', page:12}, {id:'refs-page', type:'references', page:13}
];
const before = JSON.stringify(input), outline = build(input);
assert.equal(JSON.stringify(input), before, '导航不能改动论文原始数据');
assert.equal(outline.flat.length, 11);
assert.equal(outline.byId.method, outline.byId['method-page']);
assert.equal(outline.byId.region, outline.byId['region-page']);
assert.equal(outline.byId['method-page'].page, 2, '跳到首次出现的位置');
assert.deepEqual(outline.byId.method.children.map(x => x.id), ['region-page','source']);
assert.deepEqual(outline.byId.compare.children.map(x => x.id), ['crop','water']);
assert.equal(outline.byId.crop.depth, 3, '编号层级修正错误的 level');
assert.equal(outline.byId.changes.title, '1987–2024 年土地覆盖动态');
assert.equal(outline.byId.refs, outline.byId['refs-page']);
const varied = build([
  heading('a','1','A'), heading('a-s','','局限性',2),
  heading('b','2','B'), heading('b-s','','局限性',2),
  heading('c','2','不同的章节'), heading('d','1','A',1,9,{appendix:true}),
  heading('decimal','2.1','2.10 是另一个数字',2),
  heading('evil','__proto__','安全文本')
]);
assert.equal(varied.flat.length, 8, '不同父章节、附录和不同标题不可误合并');
assert.equal(varied.byId['b-s'].parent.id, 'b');
assert.equal(varied.byId.decimal.title, '2.10 是另一个数字');
assert.equal(varied.byId.evil.title, '安全文本');
assert.equal(build([heading('x','1','A')], () => '1 Edited').byId.x.title, 'Edited');
console.log('目录去重、层级、别名、页码与正文保护检查通过');
