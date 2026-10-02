/* Reading tools share the reader's document, notes and source locations. */
(function (PR) {
  'use strict';
  const params = new URLSearchParams(location.search);
  let pendingPage = Number(params.get('source_page'));
  let controller = null, tool = params.get('tool') || 'question', initialized = false;

  function locate(url) {
    const source = new URL(url, location.href);
    if (source.pathname !== location.pathname) return false;
    const hash = decodeURIComponent(source.hash.slice(1));
    const page = Number(source.searchParams.get('source_page'));
    if (hash && document.getElementById(hash)) {
      if (innerWidth < 980) PR.openSide(null);
      PR.jumpTo(hash, { instant: innerWidth < 980 });
    } else if (page > 0) {
      const node = document.getElementById('orig-' + page);
      if (node) { if (innerWidth < 980) PR.openSide(null); PR.jumpTo(node.id, { instant: innerWidth < 980 }); }
      else { PR.$('.pv-follow input').checked = false; PR.openPage(page); }
    } else PR.toast('原段落暂未显示，请对照原文页核实。');
    return true;
  }
  PR.syncCompanion = function (name) {
    PR.$$('#companion [data-companion]').forEach(b => {
      const active = name === 'study' ? b.dataset.companion === (tool === 'knowledge' ? 'question' : tool) : b.dataset.companion === name;
      b.classList.toggle('on', active); b.setAttribute('aria-pressed', String(active));
    });
    PR.$('#studyBtn').classList.toggle('on', !!name);
    PR.$('#studyBtn').setAttribute('aria-expanded', String(!!name));
  };
  PR.openStudy = async function (mode, args) {
    if (!controller) return;
    PR.openSide('study');
    await controller.open(mode || tool, args);
  };
  PR.$('#studyBtn').onclick = () => PR.side ? PR.openSide(null) : PR.openStudy(tool);
  PR.$('#companion').addEventListener('click', e => {
    if (e.target.closest('[data-companion-close]')) return PR.openSide(null);
    const b = e.target.closest('[data-companion]');
    if (!b) return;
    const mode = b.dataset.companion;
    if (mode === 'notes') PR.toggleNotesPanel(true);
    else if (mode === 'pages') PR.togglePages(true);
    else if (mode === 'chat') PR.toggleChat(true);
    else PR.openStudy(mode);
  });
  function entries() {
    const online = PR.store.mode === 'server';
    PR.$('#studyBtn').hidden = !online;
    if (PR.refreshNavigation) PR.refreshNavigation();
    if (!online) { PR.$$('#companion .server-only').forEach(n => n.hidden = true); return; }
    PR.$('#companionResearch').href = '/study?paper=' + encodeURIComponent(PR.pid) + '&mode=research';
    if (!initialized) {
      initialized = true;
      PR.studyUI(PR.$('#studypanel'));
      controller = PR.mountStudy(PR.$('#studypanel'), {
        embedded: true, paper: PR.pid, onSource: locate,
        onMode(mode) { tool = mode; PR.syncCompanion(PR.side); },
        onSection(section) {
          if (!section) return;
          const narrow = innerWidth < 980;
          if (narrow) PR.openSide(null);
          if (document.getElementById('b-' + section.id)) PR.jumpTo('b-' + section.id, { instant: narrow });
          else if (document.getElementById('orig-' + section.page)) PR.jumpTo('orig-' + section.page, { instant: narrow });
          return !narrow;
        }
      });
      if (params.get('tool') === 'notes') PR.toggleNotesPanel(true);
      else if (params.get('tool') || params.get('analysis')) PR.openSide('study');
    }
    if (pendingPage > 0) { PR.$('.pv-follow input').checked = false; PR.openPage(pendingPage); pendingPage = 0; }
    PR.$$('#paper .blk-math, #paper .blk-table, #paper .blk-figure').forEach(node => {
      if (node.querySelector('.study-asset-link')) return;
      const button = document.createElement('button');
      button.className = 'study-asset-link';
      button.textContent = node.classList.contains('blk-math') ? '解读公式 →' : '解读图表 →';
      button.onclick = () => PR.openStudy('visual', { asset: node.dataset.id });
      node.append(button);
    });
  }
  PR.on('rendered', entries);
  PR.on('block-rendered', entries);
})(window.PR);
