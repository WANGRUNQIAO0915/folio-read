(function () {
  'use strict';
  const P=window.FolioPlatform || {},C=window.FolioMobile,S=window.FolioStorage,D=window.FolioDrive,O=window.FolioOrganization,$=s=>document.querySelector(s),E=C.esc;
  let view='library',papers=[],active=null,cloudFiles=[],selection=null,settings={},scrollTimer=0,toastTimer=0,aiOptions={},aiKey='',aiTask=null,driveFolderImportEnabled=false;
  let organization=O.empty(),pendingImport=null,importing=false,classificationSession=null,sheetEpoch=0;
  const title=data=>(data.item.meta_override || {}).title_zh || data.paper.meta.title_zh || data.paper.meta.title_en || '未命名论文';
  const effectiveMeta=data=>({...data.paper.meta,...data.item.meta_override});
  const notes=data=>Object.values(data.reader.notes || {}).filter(n=>!n.deleted || (n._syncConflicts || []).some(c=>!c.deleted));
  const percent=data=>Math.round(100*(Number((data.reader.progress || {}).ratio)||0));
  function toast(text) {$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('#toast').hidden=true;},4500);}
  async function syncCloud(onProgress) {
    try {cloudFiles=await D.syncAll(onProgress);return cloudFiles;}
    finally {papers=await S.all();organization=await S.organization();if(view==='library')library();}
  }
  function syncMessage(fallback) {
    const report=D.lastImportReport;
    if(report?.errors.length)return '同步已处理可用论文；'+report.errors.length+' 个云盘 PDF 未能导入，请在设置中查看。';
    if(report?.status==='permission_required')return '已同步应用内资料；文件夹导入仍需额外只读授权。';
    return report?.imported?'同步完成，已从云盘导入 '+report.imported+' 篇 PDF。':fallback;
  }
  function folderImportDetails() {
    const report=D.lastImportReport;
    if(!report?.errors.length)return '';
    return '<details><summary>部分云盘 PDF 未导入（'+report.errors.length+'）</summary><ul>'+report.errors.map(error=>'<li>'+E(error.name)+'：'+E(error.message)+'</li>').join('')+'</ul><p>原文件未改动。修复后再次同步会重试。</p></details>';
  }
  function sheet(name,html) {sheetEpoch++;$('#sheetTitle').textContent=name;$('#sheetBody').innerHTML=html;$('#sheet').showModal();return sheetEpoch;}
  function closeSheet() {sheetEpoch++;cancelClassification();$('#sheet').close();}
  function applyAppearance() {
    document.documentElement.dataset.theme=settings.theme==='auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light') : settings.theme;
    document.documentElement.style.setProperty('--phone-font',(Number(settings.font)||18)+'px');
    $('meta[name="theme-color"]').content=document.documentElement.dataset.theme==='dark' ? '#2d2d2b':'#f9f9f7';
  }
  function setView(next,onlyActive=false) {
    view=next;selection=null;$('#selectionTools').hidden=true;
    if(next!=='reader'){PR.citationReferences=[];PR.refById={};}
    document.body.classList.toggle('reader-mode',view==='reader');
    $('#tabs').innerHTML=view==='reader' ? '<button data-act="toc">目录</button><button data-act="paperNotes">笔记</button><button data-act="find">查找</button>' :
      ['library','knowledge','notes','settings'].map((v,i)=>'<button data-view="'+v+'" class="'+(v===view?'active':'')+'">'+['文献库','知识库','笔记','设置'][i]+'</button>').join('');
    $('#headerStatus').textContent=view==='reader' ? (active.demo?'界面示例':percent(active)+'% · 已保存') : '随身阅读';
    if(view==='library') library();if(view==='knowledge') knowledge(onlyActive).catch(error=>toast(error.message));if(view==='notes') allNotes();if(view==='settings') preferences();if(view==='reader') renderPaper();
    window.scrollTo(0,0);
  }
  function library() {
    const recent=papers.slice().sort((a,b)=>C.time(b.opened_at || b.imported_at)-C.time(a.opened_at || a.imported_at)),localIds=new Set(papers.map(p=>p.paper_id));
    const remote=[...new Set(cloudFiles.filter(f=>f.appProperties.folioType==='paper').map(f=>f.appProperties.folioPaperId))].filter(id=>!localIds.has(id)).map(id=>{const file=D.latest(cloudFiles,id);return {paper_id:id,file,paper:{meta:{title_en:file.name.replace(/\.folio\.json$/,'')}},item:{}};});
    let html='<div class="eyebrow">YOUR SHARED LIBRARY</div><h1>你的文献库</h1><p class="intro">'+(D.connected?'手机与电脑，共用同一个私有云端资料库。':(P.native?'PDF、阅读与笔记保存在此设备。云盘同步需完成 Android 授权配置。':'从手机直接导入 PDF。连接云盘后，与电脑共享资料。'))+'</p><div class="actions"><button class="primary" data-act="import">导入论文</button><button class="secondary" data-act="syncLibrary">'+(D.connected?'同步资料库':'连接云盘')+'</button></div>';
    html+='<div class="actions"><button class="secondary" data-act="manageFolders">管理文件夹</button><button class="secondary" data-act="classifyPapers">批量 AI 分类</button></div>'+folderImportDetails();
    if(!recent.length&&!remote.length)html+='<section class="empty"><h2>从这里加入第一篇论文</h2><p>选择'+(P.native?'系统文件选择器':'iPhone「文件」')+'中的 PDF，也可导入已有的阅读 HTML 或 JSON。PDF 在此设备解析，联网并连接云盘后自动上传。</p><button class="secondary" data-act="demo">试读示例</button></section>';
    if(recent.length){const data=recent[0];html+='<button class="resume" data-open="'+E(data.paper_id)+'"><div class="eyebrow">继续阅读</div><h2>'+E(title(data))+'</h2><div class="progress"><i style="width:'+percent(data)+'%"></i></div><footer><span>'+percent(data)+'% · '+notes(data).length+' 条批注</span><span>继续 →</span></footer></button>';}
    if(recent.length||remote.length){
      html+='<div class="organization-filters"><label for="libraryFolder">文件夹</label><select id="libraryFolder"><option value="*">全部文件夹</option>'+folderOptions()+'</select><label for="libraryTag">标签</label><input id="libraryTag" placeholder="按标签筛选"></div><input class="search" id="librarySearch" type="search" placeholder="查找你的论文" aria-label="查找论文">';
      if(recent.length)html+='<div class="section-label">此设备可阅读<span>'+recent.length+' 篇 · 离线缓存</span></div><div id="paperList">'+cards(recent)+'</div>';
      if(remote.length)html+='<div class="section-label">共同云端文献库<span>'+remote.length+' 篇 · 正文按需下载</span></div><div id="cloudPaperList">'+cloudCards(remote)+'</div>';
    }
    $('#app').innerHTML=html;
    for(const id of ['librarySearch','libraryFolder','libraryTag'])if($('#'+id))$('#'+id).oninput=()=>{if($('#paperList'))$('#paperList').innerHTML=cards(filterPapers(recent))||'<p class="muted">没有匹配的本机论文。</p>';if($('#cloudPaperList'))$('#cloudPaperList').innerHTML=cloudCards(filterPapers(remote))||'<p class="muted">没有匹配的云端论文。</p>';};
  }
  function cloudCards(list){return list.map(data=>'<article class="paper-card"><button class="paper-open" data-cloud="'+E(data.file.id)+'"><h3>'+E(title(data))+'</h3><div class="meta"><span>Google 云盘</span><span>下载到手机 ↓</span></div></button>'+organizationBadges(data.paper_id)+'<button class="secondary" data-organize-paper="'+E(data.paper_id)+'">文件夹与标签</button></article>').join('');}
  function cards(list) {return list.map(data=>'<article class="paper-card"><button class="paper-open" data-open="'+E(data.paper_id)+'"><h3>'+E(title(data))+'</h3><div class="meta"><span>'+E(data.paper.meta.authors || '')+'</span><span>'+percent(data)+'% · '+notes(data).length+' 条批注</span></div></button>'+organizationBadges(data.paper_id)+'<p class="small muted">'+(data.demo?'界面示例':data.synced_once?'已在云端'+((data.pending || []).length?' · 批注待同步':''):D.connected?'等待同步到云端':'此设备保存 · 连接云盘后上传')+'</p>'+window.FolioJournal.badges(effectiveMeta(data))+'<button class="secondary" data-organize-paper="'+E(data.paper_id)+'">文件夹与标签</button></article>').join('');}
  const tagInput=value=>O.tags(String(value||'').split(/[,，\n]/).map(t=>t.trim()).filter(Boolean),true,true);
  function folderOptions(selected=''){return '<option value="">未分类</option>'+O.live(organization).map(f=>'<option value="'+E(f.id)+'" '+(selected===f.id?'selected':'')+'>'+E(f.name)+'</option>').join('');}
  function organizationBadges(id){const a=O.assignment(organization,id),folder=organization.folders[a.folder_id];return '<div class="organization-badges"><span>'+E(folder?.name||'未分类')+'</span>'+a.tags.map(t=>'<span>#'+E(t)+'</span>').join('')+'</div>';}
  async function changeOrganization(fn){organization=await S.changeOrganization(fn);if(view==='library')library();return organization;}
  function filterPapers(list){const q=($('#librarySearch')?.value||'').trim().toLowerCase(),folder=$('#libraryFolder')?.value??'*',tag=($('#libraryTag')?.value||'').trim().toLowerCase();return list.filter(p=>{const a=O.assignment(organization,p.paper_id);return (folder==='*'||(a.folder_id||'')===folder)&&(!tag||a.tags.some(t=>t.toLowerCase().includes(tag)))&&(!q||[title(p),p.paper.meta.authors||'',...a.tags].join(' ').toLowerCase().includes(q));});}
  function importChooser(){if(aiTask||importing)return toast('请先完成当前任务。');pendingImport=null;sheet('导入论文','<p class="small muted">选择逻辑文件夹和多个标签。原始 PDF 不会移动，重复导入按内容去重。</p><label for="importFolder">目标文件夹</label><select id="importFolder">'+folderOptions()+'</select><label for="importTags">标签（逗号分隔，可选）</label><input id="importTags" maxlength="251000"><div class="actions"><button class="primary" id="chooseImport">选择 PDF 或阅读文件</button></div>');$('#chooseImport').onclick=()=>{try{pendingImport={folder_id:$('#importFolder').value||null,tags:tagInput($('#importTags').value)};closeSheet();$('#importFile').click();}catch(e){toast(e.message);}};}
  function manageFolders(){const opened=sheet('管理文献文件夹','<p class="small muted">文件夹仅管理文献分类，不移动或删除原始 PDF。删除后，论文会显示为未分类，标签保留。</p><label for="folderName">新文件夹名称</label><input id="folderName" maxlength="80"><button class="primary" id="addFolder">创建</button><div>'+O.live(organization).map(f=>'<section class="folder-row"><span>'+E(f.name)+'</span><button data-rename-folder="'+E(f.id)+'">重命名</button><button data-delete-folder="'+E(f.id)+'">删除</button></section>').join('')+'</div>');$('#addFolder').onclick=async()=>{const button=$('#addFolder');if(button.disabled)return;button.disabled=true;try{const value=$('#folderName').value;await changeOrganization(o=>O.createFolder(o,value));if(sheetEpoch===opened)manageFolders();toast('文件夹已保存');}catch(e){toast(e.message);button.disabled=false;}};}
  function renameFolder(id){const f=organization.folders[id];const opened=sheet('重命名文件夹','<label for="renameFolderName">文件夹名称</label><input id="renameFolderName" maxlength="80" value="'+E(f.name)+'"><div class="actions"><button class="primary" id="saveFolderName">保存名称</button></div>');$('#saveFolderName').onclick=async()=>{const button=$('#saveFolderName');if(button.disabled)return;button.disabled=true;try{const value=$('#renameFolderName').value;await changeOrganization(o=>O.renameFolder(o,id,value));if(sheetEpoch===opened)manageFolders();toast('名称已保存');}catch(e){toast(e.message);button.disabled=false;}};}
  function deleteFolder(id){const opened=sheet('删除文件夹','<p>删除「'+E(organization.folders[id].name)+'」？其中的论文会显示为未分类，标签、原始 PDF、正文和笔记均保留。</p><div class="actions"><button class="secondary" id="cancelDeleteFolder">取消</button><button class="primary" id="confirmDeleteFolder">确认删除文件夹</button></div>');$('#cancelDeleteFolder').onclick=manageFolders;$('#confirmDeleteFolder').onclick=async()=>{const button=$('#confirmDeleteFolder');if(button.disabled)return;button.disabled=true;try{await changeOrganization(o=>O.deleteFolder(o,id));if(sheetEpoch===opened)manageFolders();toast('文件夹已删除');}catch(e){toast(e.message);button.disabled=false;}};}
  async function organizePaper(id){organization=await S.organization();const a=O.assignment(organization,id),p=await S.get(id)||(await S.indexes()).find(p=>p.paper_id===id)||{paper:{meta:{title_en:D.latest(cloudFiles,id)?.name.replace(/\.folio\.json$/,'')||'云端论文'}},item:{}};const opened=sheet('移动论文 / 编辑标签','<p>'+E(title(p))+'</p><label for="paperFolder">文件夹</label><select id="paperFolder">'+folderOptions(a.folder_id)+'</select><label for="paperTags">标签（逗号分隔）</label><input id="paperTags" value="'+E(a.tags.join(', '))+'" maxlength="251000"><p class="small muted">一篇论文可以有多个标签，不会复制 PDF。</p><div class="actions"><button class="primary" id="savePaperOrganization">确认保存</button></div>');$('#savePaperOrganization').onclick=async()=>{const button=$('#savePaperOrganization');if(button.disabled)return;button.disabled=true;try{const c={paper_id:id,folder_id:$('#paperFolder').value||null,...($('#paperTags').value===a.tags.join(', ')?{}:{tags:tagInput($('#paperTags').value)}),expected_version:a.version};await changeOrganization(o=>O.assign(o,[c]));if(sheetEpoch===opened)closeSheet();if(view==='reader')renderPaper();toast('文献分类已保存');}catch(e){toast(e.message);button.disabled=false;}};}
  function cancelClassification(){const session=classificationSession;classificationSession=null;if(session?.controller)session.controller.abort();if(aiTask===session?.controller)aiTask=null;}
  async function chooseClassification(){if(aiTask)return toast('请先完成当前模型任务。');organization=await S.organization();const candidates=(await corpus()).filter(p=>!p.demo);if(!candidates.length)return toast('请先导入论文。');sheet('批量 AI 分类建议','<p class="small muted">每批最多 20 篇。下一步先展示服务商和将发送的具体文本，不会立即发送。</p>'+candidates.map((p,i)=>'<label class="check-row"><input type="checkbox" name="classifyPaper" value="'+E(p.paper_id)+'" '+(i<20?'checked':'')+'>'+E(title(p))+'</label>').join('')+'<div class="actions"><button class="primary" id="previewClassification">查看发送内容</button></div>');$('#previewClassification').onclick=()=>{try{const ids=new Set([...document.querySelectorAll('[name="classifyPaper"]:checked')].map(e=>e.value));previewClassification(candidates.filter(p=>ids.has(p.paper_id)));}catch(e){toast(e.message);}};}
  function previewClassification(selected){const preview=window.FolioAI.classificationPreview(selected,organization);cancelClassification();const session={preview,selected,stage:'preview'};classificationSession=session;sheet('发送前确认','<p>将以下论文标题、摘要、正文摘录最多 3,000 字符（标题最多 300、摘要最多 2,000 字符），以及已有文件夹名称发送给你配置的模型服务。不会发送 PDF、图片、笔记或整篇正文。</p><dl class="model-disclosure"><dt>服务商 / 主机</dt><dd>'+E(preview.provider)+'</dd><dt>请求地址</dt><dd>'+E(preview.endpoint)+'</dd><dt>模型</dt><dd>'+E(preview.model)+'</dd></dl><details><summary>查看完整发送内容（'+selected.length+' 篇）</summary><pre class="classification-preview">'+E(JSON.stringify(preview.messages,null,2))+'</pre></details><label class="check-row"><input type="checkbox" id="classificationConsent">我同意将上述内容发送至此模型服务，生成分类建议</label><p class="small muted">AI 仅提供建议。你可以检查、编辑并再次确认后保存。</p><div class="actions"><button class="secondary" id="cancelClassification">取消</button><button class="primary" id="requestClassification" disabled>发送并生成建议</button></div><p id="classificationState" role="status"></p>');$('#classificationConsent').onchange=e=>{$('#requestClassification').disabled=!e.target.checked;};$('#cancelClassification').onclick=()=>{cancelClassification();closeSheet();};$('#requestClassification').onclick=async()=>{if(classificationSession!==session||session.stage!=='preview'||!$('#classificationConsent').checked)return;session.stage='request';session.controller=new AbortController();aiTask=session.controller;$('#requestClassification').disabled=true;$('#classificationConsent').disabled=true;$('#classificationState').textContent='正在生成建议，尚未更改任何分类…';try{const result=await window.FolioAI.classify(preview,{consent:true,signal:session.controller.signal});if(classificationSession!==session||session.controller.signal.aborted)return;session.stage='review';reviewClassification(session,result);}catch(e){if(classificationSession===session){session.stage='failed';$('#classificationState').textContent=e.message+' 关闭后可重新开始，原分类未改变。';}}finally{if(aiTask===session.controller)aiTask=null;}};}
  function reviewClassification(session,suggestions){sheet('检查并编辑分类建议','<p class="small muted">以下建议尚未保存。可修改目标文件夹和标签，确认后一次性应用。</p>'+suggestions.map((s,i)=>'<section class="classification-row" data-review-paper="'+E(s.paper_id)+'"><h3>'+E(title(session.selected.find(p=>p.paper_id===s.paper_id)))+'</h3><label for="reviewFolder'+i+'">已有文件夹</label><select id="reviewFolder'+i+'">'+folderOptions(s.folder_id)+'</select><label for="reviewNewFolder'+i+'">或新建文件夹（填写后优先使用）</label><input id="reviewNewFolder'+i+'" maxlength="80" value="'+E(s.folder_name)+'"><label for="reviewTags'+i+'">标签（逗号分隔）</label><input id="reviewTags'+i+'" maxlength="251000" value="'+E(s.tags.join(', '))+'"></section>').join('')+'<div class="actions"><button class="secondary" id="discardClassification">放弃建议</button><button class="primary" id="applyClassification">确认应用 '+suggestions.length+' 篇</button></div>');$('#discardClassification').onclick=()=>{cancelClassification();closeSheet();};$('#applyClassification').onclick=async()=>{if(classificationSession!==session||session.stage!=='review')return;const button=$('#applyClassification');button.disabled=true;try{const changes=suggestions.map((s,i)=>({...s,folder_id:$('#reviewNewFolder'+i).value.trim()?null:($('#reviewFolder'+i).value||null),folder_name:$('#reviewNewFolder'+i).value.trim(),tags:tagInput($('#reviewTags'+i).value)}));session.stage='apply';await changeOrganization(o=>O.assign(o,changes));if(classificationSession!==session)return;cancelClassification();closeSheet();toast('分类建议已确认保存');}catch(e){if(classificationSession===session){session.stage='review';button.disabled=false;toast(e.message);}}};}
  async function openPaper(id,block) {
    active=await S.update(id,data=>{data.opened_at=new Date().toISOString();});
    setView('reader');
    const target=block || (active.reader.progress || {}).block;
    if(target) requestAnimationFrame(()=>{const el=document.getElementById('b-'+target);if(el) el.scrollIntoView();});
  }
  const md=(text,block)=>PR.md(text,{sourceLinks:block && block.source_links});
  function textRoot(text,key,lang,block) {return '<div class="textroot '+lang+'" data-key="'+E(key)+'" data-lang="'+lang+'">'+md(text,block)+'</div>';}
  function content(block) {
    const en=(text,key)=>settings.bilingual && block.zh && text ? textRoot(text,key,'en',block):'';
    const changed=(active.reader.edits || {})[block.id];
    const zh=changed && !changed.reverted ? changed.zh : block.zh;
    if(block.type==='heading') return '<h'+(block.level===1?2:3)+'>'+(block.num?'<span class="num">'+E(block.num)+' </span>':'')+textRoot(zh || block.en || '',block.id,zh?'zh':'en',block)+'</h'+(block.level===1?2:3)+'>'+en(block.en,block.id);
    if(block.type==='para' || block.type==='note') return textRoot(zh || block.en,block.id,zh?'zh':'en',block)+en(block.en,block.id);
    if(block.type==='list') {const tag=block.ordered?'ol':'ul';return '<'+tag+'>'+(block.items || []).map((item,i)=>'<li>'+textRoot(item.zh || item.en,block.id+'#'+i,'zh',block)+en(item.en,block.id+'#'+i)+'</li>').join('')+'</'+tag+'>';}
    if(block.type==='math') return '<div class="math">'+PR.tex(block.tex || '',true)+'</div>';
    if(block.type==='figure') {
      const src=active.images[block.src];
      return (src?'<img src="'+E(src)+'" data-image="'+E(block.src)+'" alt="'+E(PR.plain(block.caption_zh || '论文插图'))+'" loading="lazy">':'<p class="muted small">图见原文第 '+E(block.page || '?')+' 页</p>')+
        '<div class="caption">'+textRoot(block.caption_zh || block.caption_en || '',block.id+'#caption','zh',block)+en(block.caption_en,block.id+'#caption')+'</div>';
    }
    if(block.type==='table') {
      const rows=(block.head || []).map(row=>'<tr>'+row.map(x=>'<th>'+md(x,block)+'</th>').join('')+'</tr>').join('')+
        (block.rows || []).map(row=>'<tr>'+row.map(x=>'<td>'+md(x,block)+'</td>').join('')+'</tr>').join('');
      return '<div class="table-scroll"><table>'+rows+'</table></div><div class="caption">'+textRoot(block.caption_zh || '',block.id+'#caption','zh',block)+en(block.caption_en,block.id+'#caption')+'</div>';
    }
    if(block.type==='references') return '<ul class="refs">'+(active.paper.references || []).map(ref=>'<li id="ref-'+E(ref.id)+'">['+E(ref.id)+'] '+md(ref.text)+'</li>').join('')+'</ul>';
    return textRoot(zh || block.en || '',block.id,'zh',block);
  }
  function renderPaper() {
    const meta=effectiveMeta(active);
    PR.citationReferences=active.paper.references || [];PR.refById=Object.fromEntries(PR.citationReferences.map(r=>[String(r.id),r]));
    $('#app').innerHTML='<div class="reader-actions"><button data-act="library">← 文献库</button><button data-act="bilingual">'+(settings.bilingual?'仅中文':'原文对照')+'</button><button data-act="original">原页</button><button data-act="type">Aa</button></div>'+
      '<h1 class="reader-title">'+E(title(active))+'</h1><p class="reader-meta">'+E(meta.authors || '')+' · '+E(meta.page_count || (meta.pages || []).length || '?')+' 页'+(active.demo?' · 简短界面示例，非完整译文':'')+'</p><div class="actions"><button class="secondary" data-act="translatePaper">翻译为中文</button><button class="secondary" data-act="askPaper">问这篇论文</button><button class="secondary" data-organize-paper="'+E(active.paper_id)+'">文件夹与标签</button></div>'+organizationBadges(active.paper_id)+
      window.FolioJournal.badges(meta)+(window.FolioJournal.visible(meta)?'<details class="journal-panel"><summary>期刊分区与来源</summary>'+window.FolioJournal.details(meta)+'</details>':'')+
      (meta.text_status==='original'?'<p class="document-status">'+E(meta.extraction_note || 'PDF 原文，可阅读和检索；尚未翻译。')+'</p>':'')+
      '<article id="paper" class="reader-paper">'+active.paper.blocks.map(b=>'<section class="blk" id="b-'+E(b.id)+'" data-block="'+E(b.id)+'">'+(b.page?'<div class="pg">p.'+E(b.page)+'</div>':'')+content(b)+'</section>').join('')+'</article>';
    if(!(active.paper.blocks||[]).some(b=>b.type==='references') && (active.paper.references||[]).length){const block={id:'folio-references',type:'references'};$('#paper').insertAdjacentHTML('beforeend','<section class="blk" id="b-folio-references">'+content(block)+'</section>');}
    applyMarks();
  }
  function textNodes(root) {
    const nodes=[],walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('.katex-mathml,button,.pg') ? NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
    for(let n;(n=walk.nextNode());) nodes.push(n);return nodes;
  }
  function offset(root,node,offset) {
    let result=0;
    for(const text of textNodes(root)) {
      if(text===node) return result+offset;
      const range=document.createRange();range.selectNodeContents(text);
      if(range.comparePoint(node,offset)<0) return result;
      result+=text.data.length;
    }
    return result;
  }
  function captureSelection() {
    if(view!=='reader') return;
    const selected=getSelection();
    if(!selected || !selected.rangeCount || selected.isCollapsed) return;
    const range=selected.getRangeAt(0),paper=$('#paper');
    if(!paper.contains(range.startContainer) || !paper.contains(range.endContainer)) return;
    const segments=[];
    for(const root of paper.querySelectorAll('.textroot')) {
      if(!range.intersectsNode(root)) continue;
      const text=textNodes(root).map(t=>t.data).join(''),start=offset(root,range.startContainer,range.startOffset),end=offset(root,range.endContainer,range.endOffset);
      if(start>=end || !text.slice(start,end).trim()) continue;
      const block=root.closest('.blk'),lang=root.dataset.lang;
      segments.push({anchor:block.dataset.block,key:root.dataset.key,lang,root_index:lang==='en'?[...block.querySelectorAll('.en')].indexOf(root):0,
        quote:text.slice(start,end),prefix:text.slice(Math.max(0,start-32),start),suffix:text.slice(end,end+32)});
    }
    if(!segments.length) return;
    selection={...segments[0],segments,quote:segments.map(s=>s.quote).join('\n')};$('#selectionTools').hidden=false;
  }
  function applyMarks() {
    for(const note of notes(active).filter(n=>!n.deleted && n.quote)) for(const segment of note.segments || [note]) {
      const block=document.getElementById('b-'+segment.anchor);if(!block) continue;
      const root=segment.lang==='en'?block.querySelectorAll('.en')[segment.root_index || 0]:[...block.querySelectorAll('.zh')].find(x=>x.dataset.key===segment.key);
      if(!root) continue;
      const nodes=textNodes(root),text=nodes.map(n=>n.data).join('');let start=-1,best=-1;
      for(let i=text.indexOf(segment.quote);i>=0;i=text.indexOf(segment.quote,i+1)) {
        const score=(segment.prefix && text.slice(Math.max(0,i-segment.prefix.length),i).endsWith(segment.prefix.slice(-8))?2:0)+
          (segment.suffix && text.slice(i+segment.quote.length).startsWith(segment.suffix.slice(0,8))?2:0);
        if(score>best) {best=score;start=i;}
      }
      if(start<0) continue;
      let pos=0;
      for(const textNode of nodes) {
        const a=pos,b=pos+textNode.data.length;pos=b;if(b<=start || a>=start+segment.quote.length) continue;
        const from=Math.max(start,a)-a,to=Math.min(start+segment.quote.length,b)-a;let node=textNode;
        if(to<node.length) node.splitText(to);if(from>0) node=node.splitText(from);
        const mark=document.createElement('mark');mark.className='folio-hl '+(['yellow','green','blue','pink'].includes(note.color)?note.color:'yellow')+(note.style==='underline'?' underline':'');mark.dataset.note=note.id;
        node.parentNode.insertBefore(mark,node);mark.append(node);
      }
    }
  }
  async function addHighlight(color) {
    if(!selection) return;const at=new Date().toISOString();
    const note={...selection,id:'n-'+crypto.randomUUID(),kind:'highlight',color,style:'marker',body:'',created:at,updated:at};
    active=await S.commit(active.paper_id,[{op:'note',note}]);selection=null;getSelection().removeAllRanges();$('#selectionTools').hidden=true;renderPaper();toast('标注已保存在手机');
  }
  function noteEditor(id) {
    const existing=id && active.reader.notes[id];
    const draft=existing || {...(selection || {}),anchor:(selection || {}).anchor || (active.reader.progress || {}).block || active.paper.blocks[0]?.id || 'head'};
    selection=null;getSelection().removeAllRanges();$('#selectionTools').hidden=true;
    sheet(existing?'修改注记':'添加注记',(draft.quote?'<blockquote>'+E(draft.quote)+'</blockquote>':'')+'<textarea id="noteBody" rows="5" placeholder="写下你的理解、疑问或想法" aria-label="注记正文">'+E(draft.body || '')+'</textarea><div class="actions"><button class="primary" id="saveNote">保存注记</button>'+(existing?'<button class="secondary" id="deleteNote">删除</button>':'')+'</div>');
    $('#saveNote').onclick=async()=>{
      try {
        const at=new Date().toISOString(),note={...draft,id:existing?existing.id:'n-'+crypto.randomUUID(),kind:existing?existing.kind:'note',body:$('#noteBody').value,created:draft.created || at,updated:at};
        active=await S.commit(active.paper_id,[{op:'note',note}]);closeSheet();if(view==='reader') renderPaper();else allNotes();toast('注记已保存');
      } catch(error) {toast(error.message);}
    };
    if(existing) $('#deleteNote').onclick=async()=>{active=await S.commit(active.paper_id,[{op:'note_del',id,at:new Date().toISOString()}]);closeSheet();if(view==='reader') renderPaper();else allNotes();toast('注记已删除');};
  }
  function noteCards(data) {
    return notes(data).map(note=>'<section class="note-card"><footer><span>'+E(title(data))+'</span><button data-note="'+E(note.id)+'" data-paper="'+E(data.paper_id)+'">'+(note.deleted?'删除冲突':'编辑')+'</button></footer>'+
      (note.quote?'<blockquote>'+E(note.quote)+'</blockquote>':'')+(note.body?PR.mdBlocks(note.body):'<p class="muted small">'+(note.kind==='highlight'?'文字标注':'注记')+'</p>')+
      (note._syncConflicts || []).map(n=>'<details class="conflict"><summary>另一设备的修改 · '+(n.deleted?'已删除':'保留的版本')+'</summary><p>'+E(n.body || n.quote || '')+'</p></details>').join('')+
      ((note._syncConflicts || []).length?'<p class="small muted">检查其他版本，合并到注记后再确认。</p><button data-resolve="'+E(note.id)+'" data-paper="'+E(data.paper_id)+'">确认采用当前版本'+(note.deleted?'（删除）':'')+'</button>':'')+
      '<footer><span>'+E(new Date(note.updated || note.created).toLocaleDateString('zh-CN'))+'</span><button data-jump="'+E(note.anchor || '')+'" data-paper="'+E(data.paper_id)+'">回到正文 →</button></footer></section>').join('');
  }
  async function allNotes() {
    papers=await S.all();
    $('#app').innerHTML='<div class="eyebrow">READING NOTES</div><h1>阅读留下的线索</h1><p class="intro">标注、理解和待解的问题。</p>'+papers.map(noteCards).join('');
    if(!papers.some(p=>notes(p).length)) $('#app').insertAdjacentHTML('beforeend','<p class="empty muted">阅读时长按选中文字，即可标注或添加注记。</p>');
  }
  function paperNotes() {sheet('这篇论文的批注',noteCards(active)+'<div class="actions"><button class="primary" data-act="addNote">添加段落注记</button></div>');}
  function preferences() {
    $('#app').innerHTML='<div class="eyebrow">MAKE IT YOURS</div><h1>阅读设置</h1><section class="settings-group"><h3>阅读外观</h3><div class="setting-row"><span>字号</span><div><button data-size="-1" aria-label="缩小字号">A−</button> <span id="fontValue">'+settings.font+'</span> <button data-size="1" aria-label="增大字号">A＋</button></div></div><div class="setting-row"><label for="theme">主题</label><select id="theme"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div></section>'+
      '<section class="settings-group"><h3>Google 云盘</h3><p id="driveState">'+(D.connected?E(D.account.emailAddress || D.account.displayName)+' · 已连接':'连接后，两端可共享论文和批注。资料保存在你自己的云盘，离线阅读不需要登录。')+'</p><div class="actions"><button class="primary" id="driveLogin">'+(D.connected?'切换账号':'连接 Google 云盘')+'</button><button class="secondary" id="driveSync" '+(!D.connected?'disabled':'')+'>立即同步</button></div><p>手机导入的 PDF、正文、译文与知识索引会上传到共同资料库。另一设备的正文与图片按需下载；知识检索使用共同云端索引。模型密钥不参与同步。</p><label class="check-row"><input id="driveFolderImport" type="checkbox" '+(driveFolderImportEnabled?'checked':'')+' '+(!D.folderReadGranted&&!driveFolderImportEnabled?'disabled':'')+'>同步时自动导入 Folio Read 文件夹中的 PDF</label><p>'+ (D.folderReadGranted?'已获得云盘只读权限；只扫描应用创建的 Folio Read 文件夹，不递归扫描子文件夹。':'普通同步仅能访问应用创建或已授权的文件。启用自动导入需额外授权读取整个 Google 云盘；应用只扫描自己创建的 Folio Read 文件夹，不递归扫描子文件夹。')+'</p>'+(!D.folderReadGranted?'<button id="driveFolderGrant" class="secondary">授权并启用自动导入</button>':'')+'<p>启用后在设备内提取正文，不调用 AI；原文件保持不变。为兼容其他设备，将按内容校验值去重，并在 Folio Read Sources 子文件夹保存一份应用管理的 PDF 副本，同时生成阅读与知识索引。</p>'+folderImportDetails()+'<details><summary class="small muted">Google 授权配置</summary><label for="googleClientId">网页客户端 ID</label><input id="googleClientId" autocapitalize="none" spellcheck="false" placeholder="…apps.googleusercontent.com" value="'+E(settings.googleClientId || '')+'"><button id="saveClient" class="secondary">保存配置</button><p>此 ID 是应用的公开登录标识，不是 API Key。首次接入需要在 Google Cloud 中创建一次。</p></details></section>'+
      '<section class="settings-group"><h3>手机模型</h3><p>手机可独立翻译和向共同知识库提问。模型请求直接发送到你填写的 API 地址；电脑上的本机模型需要电脑在线且另行配置可访问的接口。</p><label for="phoneModelBase">API 地址</label><input id="phoneModelBase" type="url" value="'+E(aiOptions.base_url || 'https://api.deepseek.com')+'" autocapitalize="none" spellcheck="false"><label for="phoneModelName">模型名称</label><input id="phoneModelName" value="'+E(aiOptions.model || 'deepseek-chat')+'" autocapitalize="none" spellcheck="false"><label for="phoneModelKey">API Key</label><input id="phoneModelKey" type="password" value="'+E(aiKey)+'" autocomplete="off" autocapitalize="none" spellcheck="false"><label class="check-row"><input id="rememberPhoneKey" type="checkbox" '+(aiOptions.remember_key?'checked':'')+'>将密钥保存在此设备</label><p>默认只在本次打开期间使用。勾选后保存在浏览器设备存储中；不上传云盘。</p><button class="secondary" id="savePhoneModel">保存模型配置</button><button class="secondary" id="forgetPhoneKey">清除设备密钥</button></section>'+
      '<section class="settings-group"><h3>离线与备份</h3><p>下载后的论文、图片和批注保存在此设备。清除 Safari 的网站数据会移除本机副本；请先同步或导出备份。</p><div class="actions"><button class="secondary" data-act="backup">导出当前论文</button><button class="secondary" data-act="import">导入阅读文件</button></div><p id="offlineState">正在检查离线阅读资源…</p></section>'+
      '<section class="settings-group"><h3>添加到 iPhone 主屏幕</h3><p class="install-note">用 Safari 打开手机阅读网址，点分享，再选「添加到主屏幕」。第一次下载论文后，离线也能打开阅读。需要 HTTPS 网址。</p></section>';
    $('#theme').value=settings.theme;
    $('#theme').onchange=async e=>{settings.theme=e.target.value;applyAppearance();await S.setting('appearance',settings);};
    $('#saveClient').onclick=async()=>{const id=$('#googleClientId').value.trim();if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) return toast('客户端 ID 格式不正确');settings.googleClientId=id;await S.setting('appearance',settings);D.loadIdentity().catch(()=>{});toast('Google 登录配置已保存');};
    $('#savePhoneModel').onclick=async()=>{try{const base=$('#phoneModelBase').value.trim(),url=new URL(base);if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash)throw new Error('请使用 HTTPS 模型 API 地址');aiKey=$('#phoneModelKey').value.trim();aiOptions={base_url:base.replace(/\/$/,''),model:$('#phoneModelName').value.trim(),remember_key:$('#rememberPhoneKey').checked};await S.setting('aiOptions',aiOptions);await S.setting('aiKey',aiOptions.remember_key?aiKey:'');window.FolioAI.setConfig({...aiOptions,api_key:aiKey});toast('手机模型配置已保存');}catch(error){toast(error.message);}};
    $('#forgetPhoneKey').onclick=async()=>{aiKey='';await S.setting('aiKey','');window.FolioAI.setConfig({api_key:''});$('#phoneModelKey').value='';toast('设备密钥已清除');};
    $('#driveFolderImport').onchange=async e=>{if(e.target.checked && !D.folderReadGranted){e.target.checked=driveFolderImportEnabled;return toast('请先获得云盘只读授权。');}driveFolderImportEnabled=e.target.checked;await S.setting('driveFolderImportEnabled',driveFolderImportEnabled);toast(driveFolderImportEnabled?'下次同步会扫描 Folio Read 文件夹中的 PDF':'已关闭云盘文件夹自动导入');};
    if($('#driveFolderGrant'))$('#driveFolderGrant').onclick=async()=>{try{if(aiTask)throw new Error('请先完成或停止模型任务。');$('#driveFolderGrant').disabled=true;await D.login(settings.googleClientId,{folderImport:true});await S.setting('driveFolderImportEnabled',true);driveFolderImportEnabled=true;await syncCloud();papers=await S.all();preferences();toast(syncMessage('已启用云盘 PDF 自动导入'));}catch(error){preferences();toast(error.message);}};
    $('#driveLogin').onclick=async()=>{try {await D.login(settings.googleClientId,{folderImport:driveFolderImportEnabled});await syncCloud();papers=await S.all();preferences();toast(syncMessage('Google 云盘已连接，共同资料库已同步'));}catch(error){toast(error.message);}};
    $('#driveSync').onclick=async()=>{try{if(aiTask)throw new Error('请先完成或停止模型任务。');$('#driveSync').disabled=true;await syncCloud((i,n)=>{if($('#driveState'))$('#driveState').textContent='正在同步 '+i+' / '+n+' 篇';});papers=await S.all();if(active) active=await S.get(active.paper_id);preferences();toast(syncMessage('同步完成'));}catch(error){preferences();toast(error.message);}};
    if(settings.googleClientId && navigator.onLine) D.loadIdentity().catch(()=>{});
    if(P.native) {
      $('#googleClientId').closest('details').hidden=true;
      if(!D.connected) $('#driveState').textContent='Android 测试版使用原生 Google 授权。需要在同一 Google 项目登记此安装包的应用 ID 和签名 SHA-1 后启用；不会在内嵌网页中登录。';
      const backup=$('#offlineState').closest('section');
      backup.querySelector('p').textContent='论文、原稿和批注保存在此应用。卸载或清除应用数据会删除它们；请先导出备份。应用更新不会主动清除资料。';
      const install=document.querySelector('.install-note').closest('section');
      install.innerHTML='<h3>Android 测试版</h3><p>阅读界面、PDF 解析器、字体和公式均随安装包提供，首次打开即可离线使用。Google 同步需原生授权配置，模型功能仍需网络和你自行配置的 API。</p>';
    }
    offlineStatus();
  }
  async function offlineStatus() {
    const el=$('#offlineState');if(!el) return;
    if(P.bundledAssets) {el.textContent='离线资源已随安装包内置，无需首次联网下载。';return;}
    if(!('serviceWorker' in navigator) || !isSecureContext) {el.textContent='离线启动需要 HTTPS 或本机预览环境。';return;}
    const registration=await navigator.serviceWorker.getRegistration();
    el.textContent=registration && registration.active?'离线启动资源已就绪。':'离线启动资源正在准备，请稍后重新打开。';
  }
  async function importFile(file) {
    if(importing)throw new Error('论文正在导入，请稍等。');importing=true;const destination=pendingImport;pendingImport=null;
    $('#importButton').disabled=true;
    try {
      let data,existingPDF=false;
      const isPdf=/\.pdf$/i.test(file.name) || file.type==='application/pdf';
      if(isPdf) {
        if(file.size>window.FolioPDF.MAX_SOURCE)throw new Error('PDF 超过 128 MB，请先压缩后导入。');
        toast('正在在此设备解析 PDF…');
        const existing=await S.get(await window.FolioPDF.sha(await file.arrayBuffer()));
        existingPDF=!!existing;
        data=existing || await window.FolioPDF.parse(file,(n,total)=>{$('#headerStatus').textContent='解析 '+n+' / '+total+' 页';});
        if(new TextEncoder().encode(JSON.stringify(data)).length>C.MAX_BYTES)throw new Error('阅读副本超过 64 MB，请拆分或压缩 PDF。');
        if(!(await S.source(data.paper_id))?.blob)await S.source(data.paper_id,{blob:file,name:file.name,bound_account:data.bound_account});
      } else {
        if(file.size>C.MAX_BYTES) throw new Error('阅读文件超过 64 MB。');
        data=C.parseImport(await file.text());
      }
      await S.importBundle(data,{preserveExisting:isPdf});
      organization=await S.organization();
      if(!existingPDF&&destination&&(destination.folder_id||destination.tags.length))await changeOrganization(o=>{const prior=O.assignment(o,data.paper_id);return O.assign(o,[{paper_id:data.paper_id,folder_id:destination.folder_id||prior.folder_id,...(destination.tags.length?{tags:O.tags([...prior.tags,...destination.tags],true,true)}:{})}]);});
      papers=await S.all();await openPaper(data.paper_id);toast('论文已导入，原稿与阅读内容保存在此设备');
      if(D.connected && navigator.onLine) {await syncCloud();papers=await S.all();active=await S.get(data.paper_id);toast(syncMessage('已上传到共同云端资料库，电脑同步后即可看到'));}
    } finally {importing=false;$('#importButton').disabled=false;}
    if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
  }
  async function corpus(onlyActive=false) {
    const local=await S.all(),cached=await S.indexes(),account=D.account?.permissionId;
    const map=new Map();
    for(const data of cached)if(!account || data.bound_account===account)map.set(data.paper_id,data);
    for(const data of local) {
      if(data.demo || (account && data.bound_account && data.bound_account!==account))continue;
      const remote=map.get(data.paper_id);
      map.set(data.paper_id,remote?{...data,reader:C.materialize([remote.reader,data.reader],data.pending || [])}:data);
    }
    const latestOrganization=await S.organization();
    return [...map.values()].filter(data=>!onlyActive || data.paper_id===active?.paper_id).map(data=>({...data,item:{...data.item,tags:O.assignment(latestOrganization,data.paper_id).tags}}));
  }
  async function knowledge(onlyActive=false) {
    const data=await corpus(onlyActive);if(view!=='knowledge')return;
    $('#app').innerHTML='<div class="eyebrow">YOUR SHARED KNOWLEDGE</div><h1>'+(onlyActive?'问这篇论文':'问共同资料库')+'</h1><p class="intro">'+data.length+' 篇资料已就绪。回答优先引用你的论文，库外补充单独标出。</p><label for="knowledgeQuestion" class="small">你想了解什么？</label><textarea id="knowledgeQuestion" rows="4" placeholder="例如：这些研究采用了哪些土地覆盖变化检测方法？"></textarea><label class="check-row"><input type="checkbox" id="knowledgeNotes" checked>包含我的笔记</label><label class="check-row"><input type="checkbox" id="knowledgeGeneral" checked>资料不足时，允许明确标出的库外补充</label><div class="actions"><button class="secondary" id="knowledgeSearch">检索资料</button><button class="primary" id="knowledgeAsk">向 AI 提问</button><button class="secondary" id="knowledgeStop" hidden>停止</button></div><p id="knowledgeState" class="small muted"></p><section id="knowledgeAnswer"></section><section id="knowledgeSources"></section>';
    const retrieve=async()=>{
      const query=$('#knowledgeQuestion').value.trim();if(!query)throw new Error('请填写问题或检索关键词。');
      const data=await corpus(onlyActive),result=window.FolioKnowledge.retrieve(data,query,$('#knowledgeNotes').checked);
      $('#knowledgeState').textContent='检索 '+result.papers+' 篇资料 · '+result.passages+' 段正文和笔记 · 命中 '+result.matched_papers+' 篇';
      $('#knowledgeSources').innerHTML='<h2>资料库来源</h2>'+(result.sources.length?result.sources.map(s=>'<article class="knowledge-source"><button class="source-link" data-knowledge-paper="'+E(s.paper_id)+'" data-knowledge-block="'+E(s.block)+'">['+s.id+'] '+E(s.title)+' · '+(s.page?'原文第 '+E(s.page)+' 页':'论文笔记')+'</button><p>'+E(s.text)+'</p></article>').join(''):'<p class="muted">没有匹配的资料。可换用论文中的关键词；英文原文可用英文关键词检索。</p>');
      return {query,result};
    };
    $('#knowledgeSearch').onclick=async()=>{try{await retrieve();}catch(error){toast(error.message);}};
    $('#knowledgeAsk').onclick=async()=>{
      if(aiTask)return toast('请先完成或停止当前模型任务。');
      if(!window.FolioAI.configured)return toast('请先在设置中配置手机使用的模型 API。');
      const controller=new AbortController();aiTask=controller;
      $('#knowledgeAsk').disabled=true;$('#knowledgeStop').hidden=false;$('#knowledgeState').textContent='正在检索资料…';
      try {
        const {query,result}=await retrieve();
        // 中英文提问可先转换检索词，正文仍以云端真实证据为准。
        if(result.sources.length<3 && /[\u4e00-\u9fff]/.test(query)) {
          const keywords=await window.FolioAI.chat([{role:'system',content:'将用户问题提炼为用于科学论文检索的 4 到 8 个英文关键词，只返回关键词，不回答问题。'}, {role:'user',content:query}],controller.signal);
          const expanded=window.FolioKnowledge.retrieve(await corpus(onlyActive),query+' '+keywords.slice(0,600),$('#knowledgeNotes').checked);
          if(expanded.sources.length>result.sources.length){result.sources=expanded.sources;result.matched_papers=expanded.matched_papers;}
        }
        $('#knowledgeState').textContent='正在根据 '+result.sources.length+' 段资料生成回答…';
        const answer=await window.FolioAI.answer(query,result,$('#knowledgeGeneral').checked,controller.signal);
        if(view!=='knowledge')return;
        $('#knowledgeAnswer').innerHTML='<div class="answer-library"><h2>来自你的资料库</h2>'+PR.mdBlocks(answer.answer_from_library)+'</div>'+(answer.outside_knowledge?'<div class="answer-outside"><h2>库外补充</h2><p class="small muted">以下内容是模型的通用知识补充，未经这些论文支持。</p>'+PR.mdBlocks(answer.outside_knowledge)+'</div>':'');
        $('#knowledgeSources').innerHTML='<h2>本次使用的资料</h2>'+result.sources.map(s=>'<article class="knowledge-source"><button class="source-link" data-knowledge-paper="'+E(s.paper_id)+'" data-knowledge-block="'+E(s.block)+'">['+s.id+'] '+E(s.title)+' · '+(s.page?'p.'+E(s.page):'笔记')+'</button><p>'+E(s.text)+'</p></article>').join('');
        $('#knowledgeState').textContent='已检索 '+result.papers+' 篇；回答附有可回到原文的来源。';
      } catch(error){toast(error.message);}finally{aiTask=null;if($('#knowledgeAsk')){$('#knowledgeAsk').disabled=false;$('#knowledgeStop').hidden=true;}}
    };
    $('#knowledgeStop').onclick=()=>aiTask?.abort();
  }
  async function translatePaper() {
    if(aiTask || D.syncing)throw new Error('请等当前任务结束后再翻译。');
    if(!window.FolioAI.configured)throw new Error('请先在手机设置中配置模型 API。');
    const id=active.paper_id,remaining=active.paper.blocks.filter(b=>b.en && !b.zh && ['heading','para','note'].includes(b.type));
    if(!remaining.length)return toast('没有待翻译的原文段落。');
    sheet('翻译为中文','<p>将未翻译的正文发送给你配置的模型服务。已完成的段落分批保存，可中止后继续。</p><p id="translationState" role="status">共 '+remaining.length+' 个段落</p><div class="actions"><button class="primary" id="startMobileTranslation">开始翻译</button><button class="secondary" id="stopMobileTranslation" hidden>停止</button></div>');
    $('#startMobileTranslation').onclick=async()=>{
      const controller=new AbortController();aiTask=controller;$('#startMobileTranslation').disabled=true;$('#stopMobileTranslation').hidden=false;
      try {
        let done=0;
        for(let i=0;i<remaining.length;) {
          const batch=[];let size=0;
          while(i<remaining.length && (size<4500 || !batch.length)){const block=remaining[i++];batch.push(block);size+=block.en.length;}
          if($('#translationState'))$('#translationState').textContent='已完成 '+done+' / '+remaining.length+' 段';
          const translated=await window.FolioAI.translate(batch,controller.signal);
          await S.update(id,data=>{for(const result of translated){const block=data.paper.blocks.find(b=>b.id===result.id);if(block && !block.zh)block.zh=result.zh;}
            const pages=[...new Set(data.paper.blocks.map(b=>b.page).filter(Boolean))];
            data.paper.translation={done_pages:pages.filter(page=>data.paper.blocks.filter(b=>b.page===page&&b.en&&['heading','para','note'].includes(b.type)).every(b=>b.zh)),note:'由手机分批翻译'};
            data.content_dirty=true;});
          done+=batch.length;
        }
        active=await S.update(id,data=>{data.paper.meta.text_status='translated';data.paper.meta.extraction_note='';data.content_dirty=true;});
        settings.bilingual=true;await S.setting('appearance',settings);closeSheet();renderPaper();toast('译文已保存，准备同步到云端');
      } catch(error){active=await S.get(id);toast(error.message);if($('#translationState'))$('#translationState').textContent='已完成的段落已经保存。重新打开翻译可继续未完成部分。';}
      finally{aiTask=null;if($('#startMobileTranslation')){$('#startMobileTranslation').disabled=false;$('#stopMobileTranslation').hidden=true;}}
      if(D.connected && navigator.onLine)try{await syncCloud();active=await S.get(id);toast(syncMessage('译文已同步，另一设备同步后即可读取'));}catch(error){toast(error.message);}
    };
    $('#stopMobileTranslation').onclick=()=>aiTask?.abort();
  }
  async function demo() {
    const data=C.normalize({paper_id:'demo-mobile',paper:{meta:{title_zh:'[示例] 注意力机制：从一篇论文开始',title_en:'Attention Is All You Need',authors:'Vaswani 等',arxiv:'1706.03762',page_count:15,pages:[]},blocks:[
      {id:'abstract',type:'heading',level:1,zh:'摘要',en:'Abstract',page:1},
      {id:'intro',type:'para',zh:'Transformer 用注意力机制处理序列之间的联系。在这个阅读示例里，你可以选中文字做标注、写下自己的理解，也可以打开原文对照。',en:'The Transformer uses attention mechanisms to model relationships within a sequence. This short sample demonstrates the reading interface.',page:1},
      {id:'method',type:'heading',level:1,zh:'注意力如何工作',en:'Attention',page:4},
      {id:'query',type:'para',zh:'查询、键和值分别记作 $Q$、$K$ 和 $V$。先计算查询与键的相似度，再对值进行加权组合。缩放因子帮助控制分数的量级。',en:'Queries, keys, and values are represented by Q, K, and V. Attention weights combine the values based on query-key compatibility.',page:4},
      {id:'equation',type:'math',tex:'\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V',page:4},
      {id:'reflection',type:'heading',level:1,zh:'留下一条阅读笔记',page:4},
      {id:'reflection-text',type:'para',zh:'阅读时，可以把一个疑问留在对应段落旁。下次打开论文，阅读位置和批注仍在手机里。示例仅用于体验界面，不是整篇论文的翻译。原论文：https://arxiv.org/abs/1706.03762',page:4}
    ]},reader:C.emptyReader(),images:{},item:{},discussion:{entries:[]}});data.demo=true;await S.save(data);papers=await S.all();await openPaper(data.paper_id);
  }
  async function downloadJson(value,name) {
    if(P.saveBlob) return P.saveBlob(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),name);
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);return true;
  }
  function outline() {
    const headings=active.paper.blocks.filter(b=>b.type==='heading'||b.type==='references');
    if(!headings.some(b=>b.type==='references') && active.paper.references.length)headings.push({id:'folio-references',type:'references'});
    const tree=window.FolioOutline.build(headings,b=>PR.plain(b.zh || b.en || ''));
    const blocks=[...document.querySelectorAll('#paper .blk')],index=blocks.findIndex(b=>b.getBoundingClientRect().bottom>90);
    let current=null;
    for(const block of blocks.slice(0,Math.max(0,index)+1)){if(tree.byId[block.dataset.block])current=tree.byId[block.dataset.block];}
    const row=node=>'<button class="toc-item'+(node===current?' current':'')+'" '+(node===current?'aria-current="location" ':'')+'data-jump="'+E(node.id)+'" data-paper="'+E(active.paper_id)+'"><span>'+E((node.num?node.num+' ':'')+node.title)+'</span><small>'+(node.page?'p.'+E(node.page):'')+'</small></button>';
    const branch=nodes=>'<ul class="toc-tree">'+nodes.map(node=>'<li>'+(node.children.length?'<details open><summary>'+row(node)+'</summary>'+branch(node.children)+'</details>':row(node))+'</li>').join('')+'</ul>';
    sheet('文章目录',tree.roots.length?'<p class="muted small">按章节层级整理，重复标题已合并。点箭头收起子章节。</p>'+branch(tree.roots):'<p class="muted">这篇论文还没有章节目录。</p>');
  }
  document.addEventListener('click',async e=>{
    try {
      const cite=e.target.closest('a.cite');if(cite){
        e.preventDefault();const ids=(cite.dataset.refs||cite.dataset.ref||'').split('|'),refs=ids.map(id=>PR.refById[id]).filter(Boolean);
        sheet('参考文献 '+cite.textContent,(cite.dataset.citeAmbiguous?'<p class="muted small">同作者同年份有多个候选，请核对条目。</p>':'')+refs.map(r=>{
          const doi=PR.safeLink(r.doi)||PR.safeLink((String(r.text||'').match(/\b10\.\d{4,9}\/[^\s<>]+/)||[])[0]?.replace(/[.,;)]+$/,'')),url=PR.safeLink(r.url);
          return '<section class="reference-entry"><span class="reference-number">['+E(r.id)+']</span><p>'+PR.md(r.text,{cite:false,xref:false})+'</p><div class="actions"><button data-ref-jump="'+E(r.id)+'">跳到文末</button><button data-ref-copy="'+E(r.id)+'">复制条目</button>'+(doi?PR.externalLink('打开 DOI ↗',doi):'')+(url&&url!==doi?PR.externalLink('查看原文 ↗',url):'')+'</div></section>';
        }).join(''));return;
      }
      const refJump=e.target.closest('[data-ref-jump]');if(refJump){const el=document.getElementById('ref-'+refJump.dataset.refJump);closeSheet();if(el)el.scrollIntoView({block:'center'});else toast('文末参考文献列表尚未生成');return;}
      const refCopy=e.target.closest('[data-ref-copy]');if(refCopy){try{await navigator.clipboard.writeText(PR.refById[refCopy.dataset.refCopy].text);toast('参考文献已复制');}catch(_){toast('请长按条目文字复制');}return;}
      const viewButton=e.target.closest('[data-view]');if(viewButton) {if(aiTask)return toast('请先完成或停止当前模型任务。');papers=await S.all();return setView(viewButton.dataset.view);}
      const knowledgeSource=e.target.closest('[data-knowledge-paper]');if(knowledgeSource){
        const id=knowledgeSource.dataset.knowledgePaper;
        if(!await S.get(id)){let file=D.latest(cloudFiles,id);if(!file){cloudFiles=await D.list();file=D.latest(cloudFiles,id);}if(!file)throw new Error('来源论文暂未在云端找到，请重新同步。');await S.save(await D.getPaper(file,cloudFiles));}
        return openPaper(id,knowledgeSource.dataset.knowledgeBlock);
      }
      const organize=e.target.closest('[data-organize-paper]');if(organize)return organizePaper(organize.dataset.organizePaper);
      const rename=e.target.closest('[data-rename-folder]');if(rename)return renameFolder(rename.dataset.renameFolder);
      const remove=e.target.closest('[data-delete-folder]');if(remove)return deleteFolder(remove.dataset.deleteFolder);
      const open=e.target.closest('[data-open]');if(open) return openPaper(open.dataset.open);
      const remote=e.target.closest('[data-cloud]');if(remote) {remote.disabled=true;const file=cloudFiles.find(f=>f.id===remote.dataset.cloud);const data=await D.getPaper(file,cloudFiles);await S.save(data);papers=await S.all();await openPaper(data.paper_id);return toast('论文已下载，可离线阅读');}
      const size=e.target.closest('[data-size]');if(size) {settings.font=Math.max(15,Math.min(26,Number(settings.font)+Number(size.dataset.size)));applyAppearance();await S.setting('appearance',settings);if($('#fontValue')) $('#fontValue').textContent=settings.font;return;}
      const resolved=e.target.closest('[data-resolve]');if(resolved){active=await S.get(resolved.dataset.paper);const note={...active.reader.notes[resolved.dataset.resolve],updated:new Date().toISOString()};delete note._syncConflicts;active=await S.commit(active.paper_id,[{op:'note',note,resolve_conflicts:true}]);if($('#sheet').open)paperNotes();else allNotes();return;}
      const color=e.target.closest('[data-color]');if(color) return await addHighlight(color.dataset.color);
      const note=e.target.closest('[data-note]');if(note) {if(note.dataset.paper) active=await S.get(note.dataset.paper);if($('#sheet').open) closeSheet();return noteEditor(note.dataset.note);}
      const jump=e.target.closest('[data-jump]');if(jump) {closeSheet();return openPaper(jump.dataset.paper,jump.dataset.jump);}
      const image=e.target.closest('[data-image]');if(image) return sheet('论文插图','<img class="original-page" alt="论文插图" src="'+E(active.images[image.dataset.image])+'">');
      const act=e.target.closest('[data-act]');if(!act) return;
      if(act.dataset.act==='import')return importChooser();
      if(act.dataset.act==='manageFolders')return manageFolders();
      if(act.dataset.act==='classifyPapers')return chooseClassification();
      if(act.dataset.act==='translatePaper') return translatePaper();
      if(act.dataset.act==='askPaper') return setView('knowledge',true);
      if(act.dataset.act==='syncLibrary') {if(aiTask)throw new Error('请先完成或停止模型任务。');if(!D.connected)return setView('settings');toast('正在同步资料库…');await syncCloud();papers=await S.all();library();toast(syncMessage('资料库已同步'));}
      if(act.dataset.act==='demo') await demo();
      if(act.dataset.act==='library') {papers=await S.all();setView('library');}
      if(act.dataset.act==='paperNotes') paperNotes();
      if(act.dataset.act==='addNote') {closeSheet();noteEditor();}
      if(act.dataset.act==='bilingual') {settings.bilingual=!settings.bilingual;await S.setting('appearance',settings);renderPaper();}
      if(act.dataset.act==='type') sheet('字号与主题','<div class="setting-row"><span>字号</span><div><button data-size="-1">A−</button> <span id="fontValue">'+settings.font+'</span> <button data-size="1">A＋</button></div></div><p class="muted small">主题可以在设置中选择浅色、深色或跟随系统。</p>');
      if(act.dataset.act==='toc') outline();
      if(act.dataset.act==='original') {
        const pages=active.paper.meta.pages || [];sheet('原文页面','<div id="sourcePDF"><button class="secondary" id="loadSourcePDF">打开完整 PDF</button></div>'+ (pages.filter(p=>active.images[p.img]).map(p=>'<p class="muted small">第 '+E(p.n)+' 页</p><img class="original-page" src="'+E(active.images[p.img])+'" alt="原文第 '+E(p.n)+' 页" loading="lazy">').join('') || '<p class="muted">可从云盘取得完整 PDF，或使用有原稿的设备再同步一次。</p>'));
        if(P.native) $('#loadSourcePDF').textContent='导出完整 PDF';
        $('#loadSourcePDF').onclick=async()=>{try{const source=await D.sourceFor(active.paper_id,cloudFiles);if(P.saveBlob){const saved=await P.saveBlob(new Blob([source.blob],{type:'application/pdf'}),source.name || 'source.pdf');toast(saved?'完整 PDF 已保存，可在系统文件应用中打开':'已取消导出');return;}const url=URL.createObjectURL(source.blob);$('#sourcePDF').innerHTML='<a class="secondary" target="_blank" rel="noopener" href="'+E(url)+'">查看完整 PDF ↗</a>';setTimeout(()=>URL.revokeObjectURL(url),300000);}catch(error){toast(error.message);}};
      }
      if(act.dataset.act==='backup') {if(!active) return toast('先打开一篇论文，再导出阅读文件');const saved=await downloadJson(C.normalize({...active,organization:await S.organization()}),title(active).replace(/[\\/:*?"<>|]/g,'')+'.folio.json');toast(saved?'已导出论文与当前批注':'已取消导出');}
      if(act.dataset.act==='find') {sheet('查找正文','<input id="findInput" type="search" class="search" placeholder="输入关键词" aria-label="查找关键词"><div id="findResults"></div>');$('#findInput').oninput=()=>{const query=$('#findInput').value.trim().toLowerCase();$('#findResults').innerHTML=query?active.paper.blocks.filter(b=>JSON.stringify(b).toLowerCase().includes(query)).map(b=>'<button class="find-match" data-jump="'+E(b.id)+'" data-paper="'+E(active.paper_id)+'">'+E(PR.plain(b.zh || b.caption_zh || b.en || '').slice(0,120))+'<small>p.'+E(b.page || '?')+'</small></button>').join('') || '<p class="muted">没有找到相关文字。</p>':'';};$('#findInput').focus();}
    } catch(error) {toast(error.message);}
  });
  $('#home').onclick=e=>{e.preventDefault();if(aiTask)return toast('请先完成或停止模型任务。');S.all().then(data=>{papers=data;setView('library');}).catch(error=>toast(error.message));};
  $('#importButton').onclick=importChooser;
  $('#sheet').addEventListener('cancel',()=>{sheetEpoch++;cancelClassification();});
  $('#sheet').addEventListener('close',()=>{sheetEpoch++;cancelClassification();});
  $('#importFile').onchange=async e=>{const file=e.target.files[0];if(file) {try{await importFile(file);}catch(error){toast(error.message);}}e.target.value='';};
  $('#sheetClose').onclick=()=>{if(aiTask && $('#translationState'))aiTask.abort();closeSheet();};
  $('#selectionTools').onpointerdown=e=>e.preventDefault();
  $('#selectionNote').onclick=()=>noteEditor();
  $('#selectionCancel').onclick=()=>{selection=null;getSelection().removeAllRanges();$('#selectionTools').hidden=true;};
  document.addEventListener('selectionchange',()=>{clearTimeout(window.folioSelectionTimer);window.folioSelectionTimer=setTimeout(captureSelection,350);});
  document.addEventListener('scroll',()=>{
    if(view!=='reader' || $('#sheet').open) return;clearTimeout(scrollTimer);
    const id=active.paper_id;
    scrollTimer=setTimeout(async()=>{
      if(view!=='reader' || !active || active.paper_id!==id) return;
      const blocks=[...$('#paper').querySelectorAll('.blk')],index=blocks.findIndex(b=>b.getBoundingClientRect().bottom>90);
      if(index<0) return;
      try{active=await S.commit(id,[{op:'progress',block:blocks[index].dataset.block,ratio:(index+1)/blocks.length,at:new Date().toISOString()}]);$('#headerStatus').textContent=active.demo?'界面示例':percent(active)+'% · 已保存';}catch(error){toast(error.message);}
    },600);
  },{passive:true});
  window.addEventListener('online',()=>toast(P.native?'已联网':'已联网，可以连接 Google 云盘并同步批注'));
  setInterval(async()=>{
    if(!D.connected || D.syncing || aiTask || !navigator.onLine || document.hidden) return;
    try{await syncCloud();papers=await S.all();
      if(view==='library')library();
      if(view==='reader' && active && getSelection().isCollapsed && !$('#sheet').open){
        const fresh=await S.get(active.paper_id),changed=C.canonical(active.reader.notes)!==C.canonical(fresh.reader.notes);
        active=fresh;if(changed){const y=window.scrollY;renderPaper();window.scrollTo(0,y);}
      }
    }catch(error){toast(error.message);}
  },60000);
  P.onBack=()=>{
    if($('#sheet').open){if(aiTask && $('#translationState'))aiTask.abort();closeSheet();return true;}
    if(!$('#selectionTools').hidden){$('#selectionCancel').click();return true;}
    if(aiTask){toast('请先完成或停止当前模型任务。');return true;}
    if(view!=='library'){setView('library');return true;}
    return false;
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyAppearance);
  (async()=>{
    driveFolderImportEnabled=await S.setting('driveFolderImportEnabled')===true;
    settings={theme:'auto',font:18,bilingual:false,...await S.setting('appearance')};
    aiOptions=await S.setting('aiOptions') || {};aiKey=aiOptions.remember_key?(await S.setting('aiKey') || ''):'';window.FolioAI.setConfig({...aiOptions,api_key:aiKey});
    if(!settings.googleClientId) {
      const config=await fetch('./config.json').then(r=>r.ok?r.json():{}).catch(()=>({}));
      if(config.google_web_client_id) settings.googleClientId=config.google_web_client_id;
    }
    applyAppearance();papers=await S.all();organization=await S.organization();setView('library');
    if(!P.bundledAssets && 'serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js').then(reg=>{
      if(reg.waiting) toast('手机阅读资源有更新，关闭后重新打开即可使用');
      navigator.serviceWorker.addEventListener('controllerchange',offlineStatus);
    }).catch(()=>toast('离线启动资源尚未准备好，当前仍可在线阅读'));
  })().catch(error=>{$('#app').innerHTML='<h1>设备存储未就绪</h1><p>'+E(error.message)+'</p>';});
})();
