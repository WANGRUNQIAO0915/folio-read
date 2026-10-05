/* Delete is reversible; only the recycle bin offers permanent removal. */
(function (PR) {
  'use strict';
  const L = PR.lib, E = PR.esc, dlg = PR.$('#trashDlg');
  const title = paper => paper.display_title || paper.title || paper.title_zh || paper.title_en || paper.id;
  const post = async (action, ids) => {
    const results = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const response = await PR.api('/api/trash/' + action, {method: 'POST', body: {ids: ids.slice(offset, offset + 500), ...(action === 'purge' ? {confirm: true} : {})}});
      results.push(...response.results);
    }
    return {results};
  };
  let deleting = false, opening = 0, state = null, focusBefore = null;

  L.refreshDeleteToolbar = () => {
    const button = PR.$('#batchDelete'), all = PR.$('#batchAll');
    button.hidden = all.hidden = !L.selecting;
    button.disabled = deleting || !L.batch.size;
    button.textContent = '删除所选' + (L.batch.size ? '（' + L.batch.size + '）' : '');
    all.disabled = !L.visibleIds?.length;
    all.textContent = L.visibleIds?.length && L.visibleIds.every(id => L.batch.has(id)) ? '取消全选' : '全选当前列表';
  };
  PR.$('#batchDelete').onclick = event => L.deletePapers([...L.batch], event.currentTarget);
  PR.$('#batchAll').onclick = () => {
    const ids = L.visibleIds || [], selected = ids.length && ids.every(id => L.batch.has(id));
    ids.forEach(id => selected ? L.batch.delete(id) : L.batch.add(id));
    L.render();
  };
  PR.$('#list').addEventListener('change', event => { if (event.target.matches('[data-batch]')) L.refreshDeleteToolbar(); });

  async function undo(ids) {
    try {
      const result = await post('restore', ids), failed = result.results.filter(row => !row.ok);
      await L.load();
      PR.toast('已恢复 ' + result.results.filter(row => row.ok).length + ' 篇' + (failed.length ? '；' + E(failed[0].error) : ''));
    } catch (error) { PR.toast('恢复失败：' + E(error.message)); }
  }
  L.deletePapers = async (ids, at) => {
    ids = [...new Set(ids)].filter(id => L.byId(id));
    if (!ids.length || deleting) return;
    deleting = true;
    L.refreshDeleteToolbar();
    const names = new Map(ids.map(id => [id, title(L.byId(id))]));
    try {
      if (!await PR.confirm({title: ids.length === 1 ? '删除这篇论文？' : '删除所选 ' + ids.length + ' 篇论文？',
        body: (ids.length === 1 ? '《' + names.get(ids[0]) + '》\n' : '') + '论文将移入回收站，PDF、译文、笔记和分类都可恢复。原来导入的外部 PDF 文件保留。',
        ok: '移到回收站', danger: true, at})) return;
      const response = await post('delete', ids), done = response.results.filter(row => row.ok), failed = response.results.filter(row => !row.ok);
      done.forEach(row => L.batch.delete(row.id));
      if (done.some(row => row.id === L.selected)) L.select(null);
      await L.load();
      if (failed.length) PR.showText('有 ' + failed.length + ' 篇未删除', failed.map(row => names.get(row.id) + '\n' + row.error).join('\n\n'));
      if (done.length) PR.toast('已移入回收站 ' + done.length + ' 篇' + (failed.length ? '，' + failed.length + ' 篇未删除' : ''), {label: '撤销', fn: () => undo(done.map(row => row.result))}, 12000);
    } catch (error) { PR.toast('删除未完成：' + E(error.message)); }
    finally { deleting = false; L.refreshDeleteToolbar(); }
  };

  document.addEventListener('keydown', event => {
    if (event.key !== 'Delete' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
      event.target.closest('input, textarea, select, [contenteditable]') || PR.$('.dialog-backdrop.open, .confirm.open, .menu.open')) return;
    const ids = L.selecting ? [...L.batch] : L.selected ? [L.selected] : [];
    if (ids.length) { event.preventDefault(); L.deletePapers(ids); }
  });

  const visible = () => state.items.filter(row => (row.title + ' ' + row.title_en).toLowerCase().includes(state.q));
  function draw() {
    const focusedSelection = document.activeElement?.dataset.trashSelect;
    const rows = visible();
    PR.$('#trashCount', dlg).textContent = state.items.length + ' 篇';
    PR.$('#trashRows', dlg).innerHTML = rows.length ? rows.map(row => '<article class="trash-row">' +
      '<input type="checkbox" data-trash-select="' + E(row.id) + '" aria-label="选择：' + E(title(row)) + '"' + (state.selected.has(row.id) ? ' checked' : '') + (state.busy ? ' disabled' : '') + '>' +
      '<div class="trash-info"><h3>' + E(title(row)) + '</h3><p>' + E(new Date(row.deleted_at).toLocaleString()) + ' · 已译 ' + row.done_pages + ' 页 · ' + row.notes + ' 条标注或笔记</p>' +
      (!row.can_restore ? '<p class="trash-error">资料库已有同一篇论文，不能覆盖现有副本。</p>' : '') + '</div>' +
      '<div class="trash-actions"><button class="btn sm line" data-trash-restore="' + E(row.id) + '"' + (!row.can_restore || state.busy ? ' disabled' : '') + '>恢复</button>' +
      '<button class="btn sm danger" data-trash-purge="' + E(row.id) + '"' + (state.busy ? ' disabled' : '') + '>永久删除</button></div></article>').join('') :
      '<p class="trash-empty">' + (state.items.length ? '没有匹配的论文' : '回收站是空的。删除的论文会先保存在这里。') + '</p>';
    PR.$('#trashMessages', dlg).textContent = state.errors.join('\n');
    PR.$('#trashAll', dlg).disabled = state.busy || !rows.length;
    PR.$('#trashAll', dlg).textContent = rows.length && rows.every(row => state.selected.has(row.id)) ? '取消全选' : '全选当前列表';
    for (const id of ['trashRestore', 'trashPurge']) PR.$('#' + id, dlg).disabled = state.busy || !state.selected.size;
    PR.$('#trashRestore', dlg).textContent = '恢复所选' + (state.selected.size ? '（' + state.selected.size + '）' : '');
    PR.$('#trashClear', dlg).disabled = state.busy || !state.items.length;
    PR.$('#trashClose', dlg).disabled = state.busy;
    PR.$('.dialog', dlg).setAttribute('aria-busy', String(state.busy));
    if (focusedSelection && !state.busy) PR.$('[data-trash-select="' + focusedSelection + '"]', dlg)?.focus();
  }
  function close() {
    if (state?.busy) return;
    state = null; opening++;
    dlg.classList.remove('open'); dlg.setAttribute('aria-hidden', 'true'); dlg.inert = true;
    if (focusBefore?.isConnected) focusBefore.focus();
    else PR.$('#trashOpen').focus();
  }
  L.openTrash = async () => {
    if (state?.busy) return;
    focusBefore = document.activeElement;
    const seq = ++opening;
    state = {items: [], selected: new Set(), q: '', busy: false, errors: []};
    dlg.inert = false; dlg.setAttribute('aria-hidden', 'false'); dlg.classList.add('open');
    PR.$('.dialog', dlg).innerHTML = '<div class="trash-head"><h2 id="trashHeading">回收站 <span class="count" id="trashCount"></span></h2><button class="btn icon" id="trashClose" aria-label="关闭回收站">' + PR.icon('x', 'sm') + '</button></div>' +
      '<p class="hint">恢复时保留 PDF、译文、笔记、分类与阅读位置。永久删除会移除本机副本，无法撤销；云盘和其他设备的副本保留。</p>' +
      '<label class="trash-search">搜索回收站<input class="input" id="trashSearch" type="search" placeholder="输入论文标题"></label>' +
      '<div class="trash-toolbar"><button class="btn sm line" id="trashAll">全选当前列表</button><button class="btn sm line" id="trashRestore" disabled>恢复所选</button><button class="btn sm danger" id="trashPurge" disabled>永久删除所选</button></div>' +
      '<p id="trashMessages" class="trash-error" role="status"></p><div id="trashRows"><p class="trash-empty">正在读取回收站…</p></div>' +
      '<div class="actions"><button class="btn sm danger" id="trashClear" disabled>清空回收站</button></div>';
    PR.$('#trashClose', dlg).focus();
    try {
      const response = await PR.api('/api/trash');
      if (seq !== opening || !state) return;
      state.items = response.items; draw();
    } catch (error) { if (seq === opening && state) { state.errors = ['读取失败：' + error.message]; draw(); } }
  };
  PR.$('#trashOpen').onclick = L.openTrash;

  async function action(kind, ids, at) {
    if (state.busy || !ids.length) return;
    const current = state;
    current.busy = true;
    try {
      if (kind === 'purge' && !await PR.confirm({title: '永久删除 ' + ids.length + ' 篇论文？', body: '本机回收站中的 PDF、译文、笔记、批注和阅读位置会被彻底删除，无法恢复。原来导入的外部文件和云盘副本保留。', ok: '永久删除', danger: true, at})) return;
      draw();
      const names = new Map(current.items.map(row => [row.id, title(row)]));
      const response = await post(kind, ids), done = response.results.filter(row => row.ok);
      current.errors = response.results.filter(row => !row.ok).map(row => names.get(row.id) + '：' + row.error);
      done.forEach(row => current.selected.delete(row.id));
      current.items = (await PR.api('/api/trash')).items;
      current.selected = new Set([...current.selected].filter(id => current.items.some(row => row.id === id)));
      await L.load();
      if (done.length) PR.toast('已' + (kind === 'restore' ? '恢复 ' : '永久删除 ') + done.length + ' 篇');
    } catch (error) { current.errors = ['操作未完成：' + error.message]; }
    finally { current.busy = false; if (state === current) { draw(); PR.$('#trashClose', dlg).focus(); } }
  }
  dlg.addEventListener('click', event => {
    if (event.target === dlg || event.target.closest('#trashClose')) return close();
    if (!state || state.busy) return;
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.trashRestore) return action('restore', [button.dataset.trashRestore], button);
    if (button.dataset.trashPurge) return action('purge', [button.dataset.trashPurge], button);
    if (button.id === 'trashAll') {
      const rows = visible(), all = rows.every(row => state.selected.has(row.id));
      rows.forEach(row => all ? state.selected.delete(row.id) : state.selected.add(row.id)); draw();
    } else if (button.id === 'trashRestore') action('restore', [...state.selected], button);
    else if (button.id === 'trashPurge') action('purge', [...state.selected], button);
    else if (button.id === 'trashClear') action('purge', state.items.map(row => row.id), button);
  });
  dlg.addEventListener('change', event => {
    const id = event.target.dataset.trashSelect;
    if (id && state && !state.busy) { event.target.checked ? state.selected.add(id) : state.selected.delete(id); draw(); }
  });
  dlg.addEventListener('input', event => { if (event.target.id === 'trashSearch' && state) { state.q = event.target.value.trim().toLowerCase(); draw(); } });
  dlg.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = PR.$$('button:not([disabled]), input:not([disabled])', dlg).filter(el => el.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  L.refreshDeleteToolbar();
})(window.PR);
