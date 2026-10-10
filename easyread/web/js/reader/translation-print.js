/* A clean print snapshot that keeps reader typography, without annotations. */
(function (PR) {
  'use strict';
  let busy = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bounded = (promise, ms, message) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]).finally(() => clearTimeout(timer));
  };

  function readerStyle(root) {
    const reader = document.getElementById('paper');
    if (!reader) return;
    const style = getComputedStyle(reader);
    for (const property of ['font-family', 'font-size', 'font-weight', 'font-style',
      'letter-spacing', 'font-variant-numeric']) {
      root.style.setProperty(property, style.getPropertyValue(property));
    }
    // Keep the unitless line height: an inherited pixel value changes captions
    // and other smaller text. Capture the actual responsive size, not just prefs.
    const size = parseFloat(style.fontSize), line = parseFloat(style.lineHeight);
    if (size && line) root.style.lineHeight = String(line / size);
    const width = reader.getBoundingClientRect().width;
    if (width > 0) root.style.setProperty('--print-reader-width', width + 'px');
    // These reader rules change at the narrow-window breakpoint. Freeze their
    // screen values so print media cannot silently select a different layout.
    const title = reader.querySelector('.paper-head h1');
    if (title) root.querySelector('.paper-head h1').style.fontSize = getComputedStyle(title).fontSize;
    const aligned = new Map([...reader.querySelectorAll('.zh[data-key]')]
      .map(element => [element.dataset.key, getComputedStyle(element).textAlign]));
    root.querySelectorAll('.zh[data-key]').forEach(element => {
      if (aligned.has(element.dataset.key)) element.style.textAlign = aligned.get(element.dataset.key);
    });
  }

  PR.translationExportWarnings = function () {
    const paper = PR.state.paper, pages = paper.meta?.pages || [];
    const done = new Set((paper.translation?.done_pages || []).map(Number));
    const missing = pages.filter(p => !done.has(Number(p.n))).length;
    let untranslated = 0;
    for (const block of paper.blocks || []) {
      for (const key of PR.blockKeys(block)) {
        const field = key.split('#')[1];
        const source = field === 'caption' ? block.caption_en : field != null ? block.items?.[+field]?.en : block.en;
        if (source && !PR.textFor(key).trim()) untranslated++;
      }
    }
    const warnings = [];
    if (missing || untranslated || paper.meta?.text_status === 'original') {
      warnings.push('译文尚不完整' + (missing ? '：' + missing + ' 页未完成翻译' : '') +
        (untranslated ? '，' + untranslated + ' 处缺少译文' : '') + '。缺译内容保留原文或原页，不会自动重新翻译。');
    }
    if (PR.store.pending) warnings.push('包含当前浏览器中尚未写入磁盘的修改。');
    return warnings;
  };

  PR.prepareTranslationPrint = async function (mode = 'zh') {
    if (!['zh', 'bi'].includes(mode)) throw new Error('未知导出模式');
    if (PR.editingKey) throw new Error('请先保存或取消正在编辑的译文，再导出');
    if (!(PR.state.paper.blocks || []).length && !(PR.state.paper.meta?.pages || []).length) {
      throw new Error('论文正文尚未准备好，请等待原页处理完成后再导出');
    }
    document.getElementById('translationPrint')?.remove();
    const root = document.createElement('article');
    root.id = 'translationPrint'; root.className = 'translation-print mode-' + mode;
    root.lang = 'zh-CN';
    root.innerHTML = PR.paperHtml(true);
    readerStyle(root);
    // Remove reader-only controls; keep the contents of figure buttons.
    root.querySelectorAll('.figure-image').forEach(button => button.replaceWith(...button.childNodes));
    const originalFor = element => {
      const block = PR.blockById[element.closest('.blk')?.dataset.id];
      const page = (PR.state.paper.meta?.pages || []).find(p => Number(p.n) === Number(block?.image_page || block?.page));
      return page?.img && PR.imageUrl(page.img);
    };
    let fallbackImages = 0, unavailableImages = 0;
    root.querySelectorAll('.fig-missing').forEach(button => {
      if (button.hidden) { button.remove(); return; }
      const label = document.createElement('p'); label.className = 'print-warning';
      label.textContent = button.textContent.replace('（点击查看）', '');
      const source = originalFor(button);
      if (source) {
        const img = document.createElement('img'); img.src = source; img.alt = '插图所在原文页';
        img.dataset.originalFallback = 'true';
        label.textContent += '（下方附原页）'; fallbackImages++;
        button.replaceWith(label, img);
      } else { unavailableImages++; button.replaceWith(label); }
    });
    root.querySelectorAll('button, .figure-tools, .edited-dot, .paper-head-actions, .paper-meta-line, .scope, .paper-naming-source, .journal-panel, .spin').forEach(el => el.remove());
    root.querySelectorAll('.caption').forEach(caption => {
      if (!caption.querySelector('.zh')?.textContent.trim()) caption.querySelector('.en')?.classList.add('original-primary');
    });
    root.querySelectorAll('summary').forEach(el => el.remove());
    root.querySelectorAll('details').forEach(el => {
      // Keep the reader's information/source-link styling without a disclosure.
      const content = document.createElement('div'); content.className = el.className;
      content.append(...el.childNodes); el.replaceWith(content);
    });
    root.querySelectorAll('[id]').forEach(el => { el.id = 'print-' + el.id; });
    root.querySelectorAll('a[href^="#"]').forEach(el => el.setAttribute('href', '#print-' + el.getAttribute('href').slice(1)));
    root.querySelectorAll('img').forEach(img => { img.loading = 'eager'; });
    // Keep numeric values intact while long labels/identifiers may wrap.
    root.querySelectorAll('th, td').forEach(cell => {
      if (/^[+−-]?\d+(?:[.,]\d+)*(?:[eE][+−-]?\d+)?(?:[%‰])?$/.test(cell.textContent.trim())) cell.style.whiteSpace = 'nowrap';
    });
    const label = document.createElement('p'); label.className = 'print-edition';
    label.textContent = 'Folio Read · ' + (mode === 'bi' ? '逐段中英对照' : '中文译文') + ' · AI 译文，请核对原文';
    root.querySelector('.paper-head')?.append(label);
    const warnings = PR.translationExportWarnings();
    for (const warning of warnings) {
      const p = document.createElement('p'); p.className = 'print-warning'; p.textContent = warning;
      root.querySelector('.paper-head')?.append(p);
    }
    document.body.append(root);
    // Newly refreshed blocks may not exist in the visible reader yet. Capture
    // their screen alignment too, before the printer changes media breakpoints.
    root.querySelectorAll('.zh').forEach(element => {
      if (!element.style.textAlign) element.style.textAlign = getComputedStyle(element).textAlign;
    });
    root.getBoundingClientRect(); // Trigger font discovery before awaiting fonts.ready.
    try {
      await bounded(document.fonts.ready, 15000, '字体加载超时，请重试');
      let failedImages = unavailableImages;
      await bounded(Promise.all([...root.querySelectorAll('img')].map(async img => {
        try { await img.decode(); } catch (_) {
          const source = !img.dataset.originalFallback && originalFor(img);
          if (source && source !== img.getAttribute('src')) {
            img.src = source;
            try {
              await img.decode(); fallbackImages++;
              const label = document.createElement('p'); label.className = 'print-warning';
              label.textContent = '插图加载失败，下方保留该图所在原文页。'; img.before(label);
              return;
            } catch (_) { /* Report the missing image below. */ }
          }
          failedImages++;
          const p = document.createElement('p'); p.className = 'print-warning';
          p.textContent = '图片未能加载：' + (img.alt || '请核对原文'); img.replaceWith(p);
        }
      })), 30000, '图片加载超时，请重试');
      if (fallbackImages) warnings.push(fallbackImages + ' 张插图使用所在原文页代替截图。');
      // Use the reader's fit first. Only content that still exceeds the paper
      // needs extra wrapping/scaling; ordinary tables retain their three rules.
      PR.fitWide(root);
      for (const box of root.querySelectorAll('.math-body, .tbl-wrap')) {
        const child = box.firstElementChild;
        if (!child) continue;
        const available = box.clientWidth;
        if (available && child.scrollWidth > available && box.classList.contains('tbl-wrap')) {
          child.classList.add('print-fit-table');
        }
        // Fixed letter spacing/padding does not shrink with font size. Recheck
        // the actual parent overflow rather than trusting one linear estimate.
        for (let attempt = 0; available && attempt < 4; attempt++) {
          const width = Math.max(child.scrollWidth, box.scrollWidth);
          if (width <= available) break;
          const fontSize = parseFloat(getComputedStyle(child).fontSize);
          if (fontSize <= 8) break;
          child.style.fontSize = Math.max(8, fontSize * (available - 2) / width) + 'px';
        }
        if (available && Math.max(child.scrollWidth, box.scrollWidth) > available) {
          // Very long content may need whole-box scaling, including its fixed
          // spacing. Zoom also scales layout height, unlike transform.
          child.style.width = Math.max(child.scrollWidth, box.scrollWidth) + 'px';
          let zoom = 1;
          for (let attempt = 0; attempt < 4; attempt++) {
            const width = Math.max(box.scrollWidth, child.getBoundingClientRect().width);
            if (width <= available) break;
            zoom *= (available - 2) / width;
            child.style.zoom = String(zoom);
          }
        }
      }
      await delay(30);
      return { root, warnings, failedImages };
    } catch (error) { root.remove(); throw error; }
  };

  PR.exportTranslationPdf = async function (mode = 'zh') {
    if (busy) return { status: 'busy' };
    busy = true;
    const button = document.querySelector('[data-translation-export]');
    if (button) button.disabled = true;
    let snapshot;
    try {
      if (PR.editingKey) throw new Error('请先保存或取消正在编辑的译文，再导出');
      await PR.refreshForExport();
      snapshot = await PR.prepareTranslationPrint(mode);
      const warnings = snapshot.warnings.slice();
      if (snapshot.failedImages) warnings.push(snapshot.failedImages + ' 张图片加载失败，PDF 将标明缺图。');
      if (warnings.length && !await PR.confirm({ title: '导出提示', body: warnings.join('\n'), ok: '继续导出' })) return { status: 'cancelled' };
      const name = (PR.state.item?.naming?.title || PR.state.paper.meta?.short_zh || PR.state.paper.meta?.title_zh || '论文')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 100) + (mode === 'bi' ? '-中英对照.pdf' : '-中文译文.pdf');
      document.body.classList.add('translation-print-active');
      const native = window.pywebview?.api?.export_translation_pdf;
      if (native) {
        const result = await native(name);
        if (result.status === 'error') throw new Error(result.error || 'PDF 保存失败');
        if (result.status === 'saved') PR.toast('译文 PDF 已保存');
        return result;
      }
      if (window.__easyreadDesktop || window.pywebview) throw new Error('桌面 PDF 导出不可用，请更新 Windows 应用后重试');
      // Browsers use their print dialog. Never report success: users may cancel.
      const oldTitle = document.title;
      try { document.title = name.replace(/\.pdf$/, ''); window.print(); }
      finally { document.title = oldTitle; }
      return { status: 'print-dialog' };
    } catch (error) {
      PR.toast('未导出：' + PR.esc(error.message));
      return { status: 'error', error: error.message };
    } finally {
      document.body.classList.remove('translation-print-active');
      snapshot?.root.remove(); busy = false;
      if (button) button.disabled = false;
    }
  };

  document.querySelector('[data-translation-export]')?.addEventListener('click', () => {
    if (busy || document.querySelector('.translation-export-dialog')) return;
    const dialog = document.createElement('dialog'); dialog.className = 'translation-export-dialog';
    dialog.innerHTML = '<form method="dialog"><h2>导出译文 PDF</h2>' +
      '<p>使用已有译文和最新修改，沿用当前阅读字体、字号、行距与版心，保留图表和公式样式。</p>' +
      '<p>A4 白底分页；过宽内容会适配纸张，换行和页码可能与阅读页不同。</p>' +
      '<p><label><input type="radio" name="mode" value="zh" checked> 中文译文</label></p>' +
      '<p><label><input type="radio" name="mode" value="bi"> 逐段中英对照</label></p>' +
      '<p>Windows 桌面版直接保存 PDF；网页或离线 HTML 请在打印窗口选择“另存为 PDF”。</p>' +
      '<button class="btn" value="cancel">取消</button> <button class="btn primary" value="export">导出</button></form>';
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      const mode = dialog.querySelector('input:checked').value, go = dialog.returnValue === 'export';
      dialog.remove(); if (go) PR.exportTranslationPdf(mode);
    }, { once: true });
    dialog.showModal();
  });
})(window.PR);
