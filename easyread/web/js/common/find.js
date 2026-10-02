/* Page search shared by the desktop reader, library and saved answers. */
(function (PR) {
  'use strict';
  let bar, input, count, root, matches = [], current = -1, observer, timer, previousFocus;
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  function create() {
    if (bar) return;
    bar = PR.el('section', {id:'pageFind', class:'page-find', hidden:true, 'aria-label':'在当前页面查找'},
      '<input type="search" aria-label="查找文字" placeholder="在当前页面查找…" maxlength="300">' +
      '<output aria-live="polite">0 / 0</output><button data-find="prev" title="上一个（Shift+Enter）" aria-label="上一个结果">↑</button>' +
      '<button data-find="next" title="下一个（Enter）" aria-label="下一个结果">↓</button>' +
      '<button data-find="close" title="关闭查找（Esc）" aria-label="关闭查找">×</button>');
    document.body.appendChild(bar);
    input = bar.querySelector('input'); count = bar.querySelector('output');
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 100); });
    bar.addEventListener('click', e => {
      const b = e.target.closest('[data-find]');
      if (!b) return;
      if (b.dataset.find === 'close') close(); else step(b.dataset.find === 'prev' ? -1 : 1);
    });
    bar.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
  }
  function search() {
    clearTimeout(timer); matches = []; current = -1;
    if (!root || !input.value) return paint();
    const nodes = [], parts = []; let offset = 0, owner;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        const p = n.parentElement;
        return p && n.data.trim() && !p.closest('script,style,textarea,input,button,[contenteditable],.katex-mathml,[hidden],[inert]') && visible(p)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    for (let n; (n = walker.nextNode());) {
      const nextOwner = n.parentElement.closest('.blk,.claim,.record-card,.row,p,li,h1,h2,h3,td,th') || root;
      if (owner && nextOwner !== owner) { parts.push('\n'); offset++; }
      owner = nextOwner; nodes.push({node:n, start:offset, end:offset + n.data.length});
      parts.push(n.data); offset += n.data.length;
    }
    const text = parts.join(''), escaped = input.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(escaped, 'giu');
    for (const hit of text.matchAll(expression)) {
      const start = hit.index, end = start + hit[0].length;
      const a = nodes.find(n => n.start <= start && n.end > start), b = nodes.find(n => n.start < end && n.end >= end);
      if (!a || !b) continue;
      const range = document.createRange(); range.setStart(a.node, start - a.start); range.setEnd(b.node, end - b.start);
      matches.push(range); if (matches.length >= 2000) break;
    }
    current = matches.length ? 0 : -1; paint(); if (matches.length) reveal();
  }
  function paint() {
    count.textContent = (current < 0 ? 0 : current + 1) + ' / ' + matches.length + (matches.length === 2000 ? '+' : '');
    bar.querySelectorAll('[data-find="prev"],[data-find="next"]').forEach(b => { b.disabled = !matches.length; });
    if (window.CSS && CSS.highlights && window.Highlight) {
      CSS.highlights.set('folio-find', new Highlight(...matches));
      CSS.highlights.set('folio-find-current', new Highlight(...(current < 0 ? [] : [matches[current]])));
    }
  }
  function reveal() {
    const range = matches[current], el = range.startContainer.parentElement;
    if (!CSS.highlights || !window.Highlight) { const s = getSelection(); s.removeAllRanges(); s.addRange(range.cloneRange()); }
    el.scrollIntoView({block:'center', behavior:'instant'});
  }
  function step(delta) {
    clearTimeout(timer);
    if (!matches.length && input.value) { search(); return; }
    if (!matches.length) return;
    current = (current + delta + matches.length) % matches.length; paint(); reveal();
  }
  function close() {
    if (!bar) return;
    bar.hidden = true; observer && observer.disconnect(); clearTimeout(timer);
    if (CSS.highlights) { CSS.highlights.delete('folio-find'); CSS.highlights.delete('folio-find-current'); }
    matches = []; current = -1;
    if (document.activeElement && bar.contains(document.activeElement)) {
      document.activeElement.blur();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({preventScroll:true});
    }
  }
  PR.openFind = function () {
    create();
    if (bar.hidden) previousFocus = document.activeElement;
    root = PR.$('#stage') || PR.$('.research-workspace') || PR.$('.lib') || document.querySelector('main') || document.body;
    const selected = getSelection().toString().trim();
    if (selected && selected.length <= 100) input.value = selected;
    bar.hidden = false; input.focus(); input.select(); search();
    observer && observer.disconnect();
    observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(search, 160); });
    observer.observe(root, {subtree:true, childList:true, characterData:true});
  };
  PR.closeFind = close;
  document.addEventListener('click', e => { if (e.target.closest('[data-page-find]')) PR.openFind(); });
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.altKey) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); PR.openFind(); }
    if (e.key === 'F3' && bar && !bar.hidden) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape' && bar && !bar.hidden) { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, true);
  const nav = PR.$('#workspaceNav');
  if (nav && !document.body.classList.contains('reader-page')) {
    const b = PR.el('button', {class:'workspace-find btn sm', 'data-page-find':true, title:'在当前页面查找（Ctrl+F）'}, PR.icon('search','sm') + '查找');
    nav.appendChild(b);
  }
})(window.PR);
