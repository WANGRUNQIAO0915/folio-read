/* 目录只整理导航，不修改正文。跨页重复标题保留到首个章节的映射。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FolioOutline = factory();
})(typeof window === 'object' ? window : this, function () {
  'use strict';
  const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function build(headings, textFor) {
    const roots = [], flat = [], byId = Object.create(null), seen = new Map();
    let stack = [];
    for (const h of headings || []) {
      if (!h.id) continue;
      const reference = h.type === 'references';
      const num = reference ? '' : clean(h.num).replace(/[.。]$/, '');
      let title = clean(textFor ? textFor(h) : h.zh || h.en);
      if (num) title = title.replace(new RegExp('^' + escapeRe(num) + '(?:[.、:：]?\\s+|[.、:：](?=[^0-9]))'), '');
      if (reference) title = title || '参考文献';
      const depth = reference ? 1 : Math.min(6, Math.max(1, num.includes('.') ? num.split('.').length : Number(h.level) || 1));
      while (stack.length && (stack[stack.length - 1].depth >= depth || stack[stack.length - 1].appendix !== !!h.appendix)) stack.pop();
      const parent = stack[stack.length - 1] || null;
      // 无编号标题只在同一父章节内合并，避免不同章节的同名小节丢失。
      const key = reference ? 'references' : JSON.stringify([!!h.appendix, num, title.toLocaleLowerCase(), num ? '' : parent && parent.id]);
      let node = seen.get(key);
      if (node) {
        node.aliases.push(h.id);
        stack = [];
        for (let p = node; p; p = p.parent) stack.unshift(p);
      } else {
        node = { id: h.id, num, title, depth, page: h.page, appendix: !!h.appendix, parent, children: [], aliases: [h.id] };
        (parent ? parent.children : roots).push(node);
        flat.push(node); seen.set(key, node); stack.push(node);
      }
      byId[h.id] = node;
    }
    return { roots, flat, byId };
  }
  return { build };
});
