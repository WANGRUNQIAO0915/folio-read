/* Review Chinese display/download names without modifying bibliographic titles or PDF bytes. */
(function (PR) {
  'use strict';
  const L = PR.lib, E = PR.esc, dlg = PR.$('#namingDlg');
  const post = (path, body) => PR.api('/api/naming/' + path, {method: 'POST', body});
  const labels = {
    existing_chinese: '已有中文标题（请核对）', bibliographic_metadata: '书目元数据',
    pdf_metadata: 'PDF 元数据', first_page_title: 'PDF 首页提取（请核对）', filename: '原文件名（请核对）',
    ai_translation: 'AI 翻译，非官方译名', manual: '人工命名'
  };
  L.namingSourceLabel = source => labels[source] || '本地建议（请核对）';
  L.refreshNamingToolbar = () => {
    const button = PR.$('#namingBtn');
    button.hidden = !L.selecting;
    button.disabled = !L.batch.size;
    button.textContent = '中文命名' + (L.batch.size ? '（' + L.batch.size + '）' : '');
  };
  PR.$('#namingBtn').onclick = () => L.openNaming([...L.batch]);
  PR.$('#list').addEventListener('change', event => {
    if (event.target.matches('[data-batch]')) L.refreshNamingToolbar();
  });
  PR.$('#detail').addEventListener('click', event => {
    const button = event.target.closest('[data-name-paper]');
    if (button) L.openNaming([button.dataset.namePaper]);
  });

  let session = 0, state = null, focusBefore = null;
  const cancelPreview = preview => { if (preview?.id) post('cancel', {id: preview.id}).catch(() => {}); };
  const currentSession = (current, seq) => current === state && seq === session;
  function shell(body, focusSelector = '[data-naming-close]') {
    dlg.querySelector('.dialog').innerHTML = '<div class="naming-head"><h2 id="namingHeading">中文命名 · ' + state.ids.length + ' 篇</h2>' +
      '<button class="btn icon" data-naming-close aria-label="关闭中文命名窗口">' + PR.icon('x', 'sm') + '</button></div>' + body;
    dlg.querySelector('.dialog').setAttribute('aria-busy', 'false');
    PR.$(focusSelector, dlg)?.focus();
  }
  function close() {
    if (state?.applying) return;
    const old = state;
    state = null;
    session++;
    dlg.classList.remove('open');
    dlg.setAttribute('aria-hidden', 'true');
    dlg.inert = true;
    cancelPreview(old?.preview);
    if (focusBefore?.isConnected) focusBefore.focus();
    else PR.$('#list').focus();
  }
  function setBusy(busy) {
    PR.$$('button, input', dlg).forEach(el => {
      if (!el.matches('[data-naming-close]')) el.disabled = busy;
    });
    dlg.querySelector('.dialog').setAttribute('aria-busy', String(busy));
  }
  function setError(message) {
    const el = PR.$('#namingError', dlg);
    if (el) el.textContent = message;
  }
  function sourceFor(draft, title) {
    return title === draft.proposed_title ? draft.proposed_source : 'manual';
  }
  function readTitle(input, draft) {
    draft.title = input.value.normalize('NFC').trim();
    draft.source = sourceFor(draft, draft.title);
    return draft.title;
  }
  function collect() {
    for (const row of PR.$$('[data-naming-index]', dlg)) {
      const input = PR.$('[data-naming-title]', row);
      const draft = state.drafts[Number(row.dataset.namingIndex)];
      const title = readTitle(input, draft);
      if (!title || [...title].length > 200) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        throw new Error(!title ? '请填写每篇论文的显示名称。' : '显示名称不能超过 200 个字符。');
      }
      input.removeAttribute('aria-invalid');
    }
  }
  function renderEdit(message = '') {
    if (!state) return;
    shell('<p class="hint">逐篇核对并修改显示名称，应用后也用于原 PDF 的下载文件名。原标题、引用信息和原 PDF 内容会保留。已有中文标题不代表官方译名。</p>' +
      (message ? '<p class="naming-message" role="status">' + E(message) + '</p>' : '') +
      '<div class="naming-paper-list">' + state.drafts.map((d, n) => '<section class="naming-paper" data-naming-index="' + n + '">' +
        '<div class="naming-paper-head"><strong>论文 ' + (n + 1) + '</strong><span class="naming-source" data-naming-source>' + E(L.namingSourceLabel(d.source)) + '</span></div>' +
        '<dl class="naming-original"><dt>原标题</dt><dd>' + E(d.original_title || '（未提取到标题）') + '</dd><dt>原文件名</dt><dd>' + E(d.original_filename || '（未记录）') + '</dd></dl>' +
        '<label for="namingTitle' + n + '">显示名称（最多 200 字符）</label>' +
        '<input class="input" id="namingTitle' + n + '" data-naming-title maxlength="400" value="' + E(d.title) + '" aria-describedby="namingFile' + n + '" autocomplete="off">' +
        '<p class="hint naming-filename" id="namingFile' + n + '">预计下载名：<span data-naming-filename>' + E(d.pdf_filename || (d.title + '.pdf')) + '</span></p>' +
        (d.proposed_source === 'ai_translation' ? '<p class="naming-ai-note">此建议由 AI 翻译生成，非官方译名，请核对术语和原意。</p>' : '') + '</section>').join('') + '</div>' +
      '<p class="hint">下载名保留 .pdf 后缀；应用时自动处理不安全字符、超长文件名及重名。不会移动或重命名磁盘或云盘中的原文件。</p>' +
      '<p class="naming-error" id="namingError" role="alert"></p><div class="actions">' +
      '<button class="btn line" id="namingAI"' + (state.ids.length > 20 ? ' disabled' : '') + '>AI 翻译建议' + (state.ids.length > 20 ? '（每批最多 20 篇）' : '') + '</button>' +
      '<span class="grow"></span><button class="btn" data-naming-close>取消</button><button class="btn accent" id="namingSave">确认应用命名</button></div>', '[data-naming-title]');
    state.phase = 'edit';
  }
  function draftFrom(s) {
    return {...s, title: s.title || '', source: s.source || 'manual',
      proposed_title: s.title || '', proposed_source: s.source || 'manual', expected_version: s.expected_version ?? ''};
  }
  async function loadSuggestions(current, seq) {
    current.busy = true;
    shell('<p role="status">正在读取本地标题和原文件名，不会调用模型…</p><div class="actions"><button class="btn" data-naming-close>取消</button></div>');
    try {
      const result = await post('suggest', {paper_ids: current.ids});
      if (!currentSession(current, seq)) return;
      const suggestions = new Map((result.suggestions || []).map(s => [s.paper_id, s]));
      if (current.ids.some(id => !suggestions.has(id))) throw new Error('部分论文未返回命名建议，请重试。');
      current.drafts = current.ids.map(id => draftFrom(suggestions.get(id)));
      current.busy = false;
      renderEdit();
    } catch (error) {
      if (!currentSession(current, seq)) return;
      current.busy = false;
      shell('<p class="naming-error" role="alert">读取本地建议失败：' + E(error.message) + '</p><div class="actions"><button class="btn" data-naming-close>取消</button><button class="btn line" id="namingRetry">重新读取</button></div>');
    }
  }
  L.openNaming = function (ids) {
    if (state) return;
    const selected = [...new Set(ids)].filter(id => L.byId(id));
    if (!selected.length) return PR.toast('请先选择论文');
    if (selected.length > 500) return PR.toast('每次最多命名 500 篇论文');
    focusBefore = document.activeElement;
    state = {ids: selected, drafts: [], busy: false, applying: false, phase: 'loading'};
    session++;
    dlg.inert = false;
    dlg.removeAttribute('aria-hidden');
    dlg.classList.add('open');
    loadSuggestions(state, session);
  };
  async function preview() {
    if (!state || state.busy || state.phase !== 'edit' || state.ids.length > 20) return;
    const current = state, seq = session;
    try {
      collect();
      current.busy = true;
      setBusy(true);
      setError('正在准备发送预览，尚未调用模型…');
      const p = await post('preview', {paper_ids: current.ids});
      if (!currentSession(current, seq)) { cancelPreview(p); return; }
      if (!p.id || !p.provider || !p.endpoint || !p.model || !Array.isArray(p.messages) || !p.messages.length) {
        cancelPreview(p);
        throw new Error('模型发送信息不完整，无法确认发送范围。');
      }
      current.preview = p;
      current.busy = false;
      current.phase = 'preview';
      shell('<h3>先确认模型与发送内容</h3><p>只有勾选同意并点击“发送并生成建议”后，才会调用下列模型。生成后仍须逐篇复核、确认应用。</p>' +
        '<dl class="naming-provider"><dt>服务商</dt><dd>' + E(p.provider) + '</dd><dt>目的地址</dt><dd>' + E(p.endpoint) + '</dd><dt>模型</dt><dd>' + E(p.model) + '</dd></dl>' +
        '<p>将发送所选论文的来源标题；缺少标题时使用有限的 PDF 首页文本。完整发送文本如下，不含原始 PDF 文件。AI 译名不是官方译名。</p>' +
        '<details open><summary>查看将发送的完整文本</summary><pre class="naming-payload">' + E(JSON.stringify(p.messages, null, 2)) + '</pre></details>' +
        '<label class="check naming-consent"><input type="checkbox" id="namingConsent">我同意将以上完整文本发送到所列服务地址和模型</label>' +
        '<p class="naming-error" id="namingError" role="alert"></p><div class="actions"><button class="btn" id="namingBack">返回修改</button><button class="btn" data-naming-close>取消</button><button class="btn accent" id="namingSend" disabled>发送并生成建议</button></div>', '#namingConsent');
    } catch (error) {
      if (!currentSession(current, seq)) return;
      current.busy = false;
      renderEdit();
      setError(error.message);
    }
  }
  async function send() {
    if (!state || state.busy || state.phase !== 'preview' || !PR.$('#namingConsent', dlg)?.checked) return;
    const current = state, seq = session;
    current.busy = true;
    setBusy(true);
    setError('正在生成建议…关闭后不会保存；已经发送的文本无法撤回。');
    try {
      const result = await post('send', {id: current.preview.id, confirmed: true});
      if (!currentSession(current, seq)) return;
      const suggestions = new Map((result.suggestions || []).map(s => [s.paper_id, s]));
      if (current.ids.some(id => !suggestions.has(id))) throw new Error('模型未返回所有论文的建议，请重试。');
      current.drafts = current.drafts.map(d => ({...draftFrom({...d, ...suggestions.get(d.paper_id)}),
        original_title: d.original_title, original_filename: d.original_filename, expected_version: d.expected_version}));
      current.busy = false;
      renderEdit('AI 建议已生成，尚未保存。请检查译名，必要时修改，然后点击“确认应用命名”。');
    } catch (error) {
      if (!currentSession(current, seq)) return;
      current.busy = false;
      renderEdit();
      setError('生成失败：' + error.message + ' 原有命名未改变。');
    }
  }
  async function apply() {
    if (!state || state.busy || state.applying || state.phase !== 'edit') return;
    const current = state;
    try {
      collect();
      current.busy = current.applying = true;
      setBusy(true);
      PR.$$('[data-naming-close]', dlg).forEach(el => { el.disabled = true; });
      setError('正在应用命名，请稍候…');
      const suggestions = current.drafts.map(({paper_id, title, source, expected_version}) => ({paper_id, title, source, expected_version}));
      const result = await post('apply', {suggestions});
      // Use confirmed server summaries immediately; a later library refresh may fail.
      for (const item of result.items || []) {
        const old = L.byId(item.id);
        if (old) Object.assign(old, item);
      }
      current.busy = current.applying = false;
      close();
      L.render();
      PR.toast('命名已保存，原 PDF 内容和书目信息保持不变');
      L.load().catch(() => PR.toast('命名已保存，但列表刷新失败，请稍后刷新页面'));
    } catch (error) {
      current.busy = current.applying = false;
      if (state !== current) return;
      renderEdit();
      setError(error.message + ' 未能确认应用结果，请刷新检查后再试；如提示版本变化，请关闭后重新打开。');
    }
  }
  dlg.addEventListener('input', event => {
    if (!event.target.matches('[data-naming-title]') || !state || state.busy) return;
    const row = event.target.closest('[data-naming-index]'), draft = state.drafts[Number(row.dataset.namingIndex)];
    readTitle(event.target, draft);
    event.target.removeAttribute('aria-invalid');
    PR.$('[data-naming-source]', row).textContent = L.namingSourceLabel(draft.source);
    PR.$('[data-naming-filename]', row).textContent = draft.title === draft.proposed_title && draft.pdf_filename ? draft.pdf_filename : (draft.title || '（待填写）') + '.pdf（应用时规范化）';
  });
  dlg.addEventListener('change', event => {
    if (event.target.id === 'namingConsent' && state && !state.busy) PR.$('#namingSend', dlg).disabled = !event.target.checked;
  });
  dlg.addEventListener('click', event => {
    if (event.target === dlg || event.target.closest('[data-naming-close]')) return close();
    const id = event.target.closest('button')?.id;
    if (id === 'namingRetry' && state && !state.busy) return loadSuggestions(state, session);
    if (id === 'namingAI') return preview();
    if (id === 'namingSend') return send();
    if (id === 'namingSave') return apply();
    if (id === 'namingBack' && state && !state.busy) {
      cancelPreview(state.preview);
      state.preview = null;
      renderEdit();
    }
  });
  dlg.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const focusable = PR.$$('button:not([disabled]), input:not([disabled]), summary', dlg).filter(el => el.offsetParent !== null);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dlg.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  dlg.inert = true;
  L.refreshNamingToolbar();
})(window.PR);
