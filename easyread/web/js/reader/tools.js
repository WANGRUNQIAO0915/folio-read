/* Explicit reading tools; modified shortcuts leave normal text editing intact. */
(function (PR) {
  'use strict';
  const tools = PR.$('#readingTools');
  let mode = 'select', color = PR.prefs.highlightColor || 'yellow', guide;
  tools.innerHTML = '<button class="btn" data-read-tool="select" title="拖选文字；双击选词；Ctrl+C 复制">选择</button>' +
    '<span class="tools-divider"></span><button class="btn" data-read-tool="marker" title="荧光笔（Ctrl+Shift+H）">' + PR.icon('marker','sm') + '荧光笔</button>' +
    '<button class="btn" data-read-tool="underline" title="下划线（Ctrl+Shift+U）">' + PR.icon('underline','sm') + '下划线</button>' +
    '<span class="dots">' + PR.HL_COLORS.map(([c,name]) => '<button class="dot-' + c + '" data-read-color="' + c + '" aria-label="' + name + '色标注" title="' + name + '色"></button>').join('') + '</span>' +
    '<button class="btn" data-read-tool="note" title="给选区或当前段写注记（Ctrl+Shift+N）">' + PR.icon('note','sm') + '注记</button>' +
    '<button class="btn" data-read-tool="undo" title="撤销本次新增标注（Ctrl+Z，正文中）" disabled>撤销</button>' +
    '<span class="tools-divider"></span><button class="btn" data-read-tool="copy" title="复制所选文字；没有选区时复制当前段">' + PR.icon('copy','sm') + '复制</button>' +
    '<button class="btn" data-page-find title="全文查找（Ctrl+F）">' + PR.icon('search','sm') + '查找</button>' +
    '<span class="tool-hint">拖选文字后复制或标注</span><button class="btn" data-read-tool="shortcuts" title="常用快捷键">快捷键</button>';
  PR.annotationUndoStack = [];
  PR.trackAnnotation = note => { PR.annotationUndoStack.push(note.id); sync(); };
  PR.undoAnnotation = wanted => {
    sync();
    const id = wanted || PR.annotationUndoStack.pop();
    if (!id) return false;
    PR.annotationUndoStack = PR.annotationUndoStack.filter(n => n !== id);
    const note = (PR.state.reader.notes || {})[id];
    if (!note || note.deleted) { sync(); return false; }
    PR.commit({op:'note_del', id}); PR.applyMarks(); PR.renderMargin();
    if (PR.notesPanelOpen()) PR.renderNotesPanel();
    PR.toast('已撤销标注'); sync(); return true;
  };
  function sync() {
    color = PR.prefs.highlightColor || color;
    PR.annotationUndoStack = PR.annotationUndoStack.filter(id => {
      const note = (PR.state.reader.notes || {})[id]; return note && !note.deleted;
    });
    document.body.classList.toggle('annotation-pen', mode !== 'select');
    tools.querySelectorAll('[data-read-tool]').forEach(b => {
      const on = b.dataset.readTool === mode; b.classList.toggle('on', on);
      if (['select','marker','underline'].includes(b.dataset.readTool)) b.setAttribute('aria-pressed', String(on));
    });
    tools.querySelectorAll('[data-read-color]').forEach(b => { b.classList.toggle('on', b.dataset.readColor === color); b.setAttribute('aria-pressed', String(b.dataset.readColor === color)); });
    tools.querySelector('[data-read-tool="undo"]').disabled = !PR.annotationUndoStack.length;
    tools.querySelector('.tool-hint').textContent = mode === 'select' ? '拖选文字后复制或标注' : '拖选文字即标注 · Esc 返回选择';
  }
  PR.setReadingTool = function (next) {
    mode = next;
    if (next !== 'select') { PR.prefs.pen = next; PR.applyPrefs(); }
    sync();
  };
  function annotate(style) {
    PR.prefs.pen = style; PR.applyPrefs();
    if (PR.captureSelection()) { PR.selectionAction('highlight',color); PR.setReadingTool('select'); }
    else PR.setReadingTool(style);
  }
  function addNote() {
    const selected = PR.captureSelection();
    PR.setReadingTool('select'); PR.toggleNotesPanel(true);
    if (selected) return PR.selectionAction('note', color);
    const id = PR.currentBlock() || PR.readingBlock();
    PR.startNote({anchor:PR.blockById[id] ? id : 'head',color});
  }
  PR.showReadingShortcuts = function () {
    if (!guide) {
      guide = PR.el('dialog', {class:'reading-shortcuts', 'aria-labelledby':'readingShortcutTitle'},
        '<header><h2 id="readingShortcutTitle">常用快捷键</h2><button class="btn" data-close-shortcuts aria-label="关闭快捷键">×</button></header>' +
        '<div class="keyrows"><kbd>Ctrl+F</kbd><span>查找当前页面文字</span><kbd>Enter / Shift+Enter</kbd><span>下一个 / 上一个搜索结果</span>' +
        '<kbd>Ctrl+C</kbd><span>复制选中文字（支持跨段）</span><kbd>Ctrl+V</kbd><span>在注记或其他文本框中粘贴</span>' +
        '<kbd>Ctrl+Shift+H</kbd><span>荧光笔标注选区</span><kbd>Ctrl+Shift+U</kbd><span>下划线标注选区</span>' +
        '<kbd>Ctrl+Shift+N</kbd><span>给选区或当前段写注记</span><kbd>Ctrl+Z</kbd><span>在正文中撤销本次新增标注</span>' +
        '<kbd>1 / 2 / 3 / 4</kbd><span>选区标为黄 / 绿 / 蓝 / 红色</span><kbd>M</kbd><span>查看全部批注</span>' +
        '<kbd>Esc</kbd><span>结束画笔、关闭查找或面板</span></div><p class="hint">双击正文选词；改译文使用段落的“改译文”或 E。单键快捷键可在设置中调整；文本框中的复制、粘贴和撤销遵循正常编辑习惯。</p>');
      document.body.appendChild(guide); guide.querySelector('[data-close-shortcuts]').onclick = () => guide.close();
    }
    if (!guide.open) guide.showModal();
  };
  tools.addEventListener('mousedown', e => e.preventDefault());
  tools.addEventListener('click', e => {
    const c = e.target.closest('[data-read-color]');
    if (c) { color = c.dataset.readColor; PR.prefs.highlightColor = color; PR.applyPrefs(); annotate(PR.prefs.pen === 'underline' ? 'underline' : 'marker'); sync(); return; }
    const b = e.target.closest('[data-read-tool]'); if (!b) return;
    const action = b.dataset.readTool;
    if (action === 'select') PR.setReadingTool('select');
    if (action === 'marker' || action === 'underline') annotate(action);
    if (action === 'note') addNote();
    if (action === 'undo') PR.undoAnnotation();
    if (action === 'copy') {
      const text = getSelection().toString();
      if (text) PR.copyText(text); else if (!PR.blockAction('copy')) PR.toast('先拖选要复制的文字');
    }
    if (action === 'shortcuts') PR.showReadingShortcuts();
  });
  document.addEventListener('mouseup', e => {
    if (mode === 'select' || !e.target.closest('#paper') || e.button !== 0) return;
    setTimeout(() => { if (mode !== 'select' && PR.captureSelection()) PR.selectionAction('highlight',color); }, 25);
  });
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing || e.target.closest('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
    const key = e.key.toLowerCase(), modifier = e.ctrlKey || e.metaKey;
    if (modifier && e.shiftKey && ['h','u','n'].includes(key)) {
      e.preventDefault(); e.stopImmediatePropagation(); key === 'n' ? addNote() : annotate(key === 'u' ? 'underline' : 'marker');
    }
    if (modifier && !e.shiftKey && key === 'z' && PR.annotationUndoStack.length) { e.preventDefault(); PR.undoAnnotation(); }
    if (key === 'escape' && mode !== 'select') { e.preventDefault(); PR.setReadingTool('select'); }
  }, true);
  PR.on('reader', sync);
  PR.on('reading-prefs', sync);
  sync();
})(window.PR);
