(function (PR) {
  'use strict';
  const nav = PR.$('#workspaceNav');
  if (!nav) return;
  const isReader = document.body.classList.contains('reader-page');
  const isResearch = document.body.classList.contains('research-page');
  const isKnowledge = isResearch && ['knowledge','compare'].includes(new URLSearchParams(location.search).get('mode'));
  const isStatic = !!PR.$('#pr-data');
  if (isStatic) { nav.hidden = true; document.body.classList.add('offline-reader'); return; }
  PR.applyTheme(PR.ls.get('easyread-prefs', {}).theme);
  nav.innerHTML = '<a class="workspace-brand" href="/">' + PR.logo() + '<span>Folio Read</span></a>' +
    '<nav aria-label="主导航"><a id="currentReading" href="/"' + (isReader ? ' aria-current="page"' : '') + '>阅读</a>' +
    '<a href="/"' + (!isReader && !isResearch ? ' aria-current="page"' : '') + '>文献库</a>' +
    '<a id="knowledgeNav" href="/study?mode=knowledge"' + (isKnowledge ? ' aria-current="page"' : '') + '>知识问答</a>' +
    '<a id="researchNav" href="/study?mode=research"' + (isResearch && !isKnowledge ? ' aria-current="page"' : '') + '>研究主题</a></nav>' +
    '<span class="workspace-caption">个人阅读空间</span>';
  let papers = [];
  PR.refreshNavigation = function (items) {
    if (items) papers = items;
    let saved = PR.ls.get('easyread-current-reading', '');
    if (isReader && PR.pid) { saved = PR.pid; PR.ls.set('easyread-current-reading', saved); }
    if (!isReader && papers.length && !papers.some(p => p.id === saved)) saved = '';
    const recent = papers.filter(p => p.last_opened).sort((a,b) => b.last_opened.localeCompare(a.last_opened))[0];
    if (!saved && recent) { saved = recent.id; PR.ls.set('easyread-current-reading', saved); }
    const link = PR.$('#currentReading');
    link.href = saved ? '/read/' + encodeURIComponent(saved) : '/';
    link.title = saved ? '继续上次阅读' : '请先从文献库打开论文';
    const resume = PR.$('#resumeReading');
    const paper = papers.find(p => p.id === saved);
    if (resume) {
      resume.hidden = !paper;
      if (paper) resume.innerHTML = '<div><span class="eyebrow">继续阅读</span><b title="' + PR.esc(paper.display_title || paper.title_zh || paper.title_en || paper.id) + '">' + PR.esc(paper.display_title || paper.short_zh || paper.title_zh || paper.title_en || paper.id) + '</b><span class="hint">' +
        (paper.progress ? '阅读进度 ' + Math.round(paper.progress * 100) + '%' : '从上次的位置继续') + '</span></div><a class="btn accent" href="' + link.href + '">继续阅读 →</a>';
    }
  };
  PR.refreshNavigation();
  const filter = PR.$('#libraryFilter');
  if (filter) {
    const opened = innerWidth > 1100 && PR.ls.get('easyread-library-filters', true);
    document.body.classList.toggle('filters-open', opened);
    filter.setAttribute('aria-expanded', String(opened));filter.classList.toggle('on', opened);
    filter.onclick = () => {
    const opened = document.body.classList.toggle('filters-open');
    filter.setAttribute('aria-expanded', String(opened));filter.classList.toggle('on', opened);
    PR.ls.set('easyread-library-filters', opened);
    };
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('filters-open')) filter.click();
  });
})(window.PR);
