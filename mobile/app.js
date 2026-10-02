(function () {
  'use strict';
  const C=window.FolioMobile,S=window.FolioStorage,D=window.FolioDrive,$=s=>document.querySelector(s),E=C.esc;
  let view='library',papers=[],active=null,cloudFiles=[],selection=null,settings={},scrollTimer=0,toastTimer=0;
  const title=data=>(data.item.meta_override || {}).title_zh || data.paper.meta.title_zh || data.paper.meta.title_en || '未命名论文';
  const notes=data=>Object.values(data.reader.notes || {}).filter(n=>!n.deleted || (n._syncConflicts || []).some(c=>!c.deleted));
  const percent=data=>Math.round(100*(Number((data.reader.progress || {}).ratio)||0));
  function toast(text) {$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('#toast').hidden=true;},4500);}
  function sheet(name,html) {$('#sheetTitle').textContent=name;$('#sheetBody').innerHTML=html;$('#sheet').showModal();}
  function closeSheet() {$('#sheet').close();}
  function applyAppearance() {
    document.documentElement.dataset.theme=settings.theme==='auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light') : settings.theme;
    document.documentElement.style.setProperty('--phone-font',(Number(settings.font)||18)+'px');
    $('meta[name="theme-color"]').content=document.documentElement.dataset.theme==='dark' ? '#2d2d2b':'#f9f9f7';
  }
  function setView(next) {
    view=next;selection=null;$('#selectionTools').hidden=true;
    document.body.classList.toggle('reader-mode',view==='reader');
    $('#tabs').innerHTML=view==='reader' ? '<button data-act="toc">目录</button><button data-act="paperNotes">笔记</button><button data-act="find">查找</button>' :
      ['library','notes','settings'].map((v,i)=>'<button data-view="'+v+'" class="'+(v===view?'active':'')+'">'+['阅读','笔记','设置'][i]+'</button>').join('');
    $('#headerStatus').textContent=view==='reader' ? (active.demo?'界面示例':percent(active)+'% · 已保存') : '随身阅读';
    if(view==='library') library();if(view==='notes') allNotes();if(view==='settings') preferences();if(view==='reader') renderPaper();
    window.scrollTo(0,0);
  }
  function library() {
    const recent=papers.slice().sort((a,b)=>C.time(b.opened_at || b.imported_at)-C.time(a.opened_at || a.imported_at));
    let html='<div class="eyebrow">YOUR READING SPACE</div><h1>随时继续阅读</h1><p class="intro">论文与笔记，带在身边。</p>';
    if(!recent.length) html+='<section class="empty"><h2>把第一篇论文带到手机</h2><p>从电脑版导出离线阅读文件，再在这里导入。下载到手机后，断网也能阅读和做笔记。</p><div class="actions"><button class="primary" data-act="import">导入论文</button><button class="secondary" data-act="demo">试读示例</button></div></section>';
    else {
      const data=recent[0];
      html+='<button class="resume" data-open="'+E(data.paper_id)+'"><div class="eyebrow">继续阅读</div><h2>'+E(title(data))+'</h2><div class="progress"><i style="width:'+percent(data)+'%"></i></div><footer><span>'+percent(data)+'% · '+notes(data).length+' 条批注</span><span>继续 →</span></footer></button>';
      html+='<input class="search" id="librarySearch" type="search" placeholder="查找你的论文" aria-label="查找论文"><div class="section-label">已下载<span>'+recent.length+' 篇 · 可离线阅读</span></div><div id="paperList">'+cards(recent)+'</div>';
    }
    const localIds=new Set(papers.map(p=>p.paper_id));
    const ids=[...new Set(cloudFiles.filter(f=>f.appProperties.folioType==='paper').map(f=>f.appProperties.folioPaperId))].filter(id=>!localIds.has(id));
    if(ids.length) html+='<div class="section-label">云端论文<span>按需下载</span></div>'+ids.map(id=>{
      const file=D.latest(cloudFiles,id);
      return '<button class="paper-card" data-cloud="'+E(file.id)+'"><h3>'+E(file.name.replace(/\.folio\.json$/,''))+'</h3><div class="meta"><span>Google 云盘</span><span>下载到手机 ↓</span></div></button>';
    }).join('');
    $('#app').innerHTML=html;
  }
  function cards(list) {return list.map(data=>'<button class="paper-card" data-open="'+E(data.paper_id)+'"><h3>'+E(title(data))+'</h3><div class="meta"><span>'+E(data.paper.meta.authors || '')+'</span><span>'+percent(data)+'% · '+notes(data).length+' 条批注</span></div></button>').join('');}
  async function openPaper(id,block) {
    active=await S.update(id,data=>{data.opened_at=new Date().toISOString();});
    setView('reader');
    const target=block || (active.reader.progress || {}).block;
    if(target) requestAnimationFrame(()=>{const el=document.getElementById('b-'+target);if(el) el.scrollIntoView();});
  }
  const md=(text,block)=>PR.md(text,{sourceLinks:block && block.source_links});
  function textRoot(text,key,lang,block) {return '<div class="textroot '+lang+'" data-key="'+E(key)+'" data-lang="'+lang+'">'+md(text,block)+'</div>';}
  function content(block) {
    const en=(text,key)=>settings.bilingual && text ? textRoot(text,key,'en',block):'';
    const changed=(active.reader.edits || {})[block.id];
    const zh=changed && !changed.reverted ? changed.zh : block.zh;
    if(block.type==='heading') return '<h'+(block.level===1?2:3)+'>'+textRoot(zh || block.en,block.id,'zh',block)+'</h'+(block.level===1?2:3)+'>'+en(block.en,block.id);
    if(block.type==='para' || block.type==='note') return textRoot(zh || block.en,block.id,'zh',block)+en(block.en,block.id);
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
    if(block.type==='references') return '<ul class="refs">'+(active.paper.references || []).map(ref=>'<li>['+E(ref.id)+'] '+md(ref.text)+'</li>').join('')+'</ul>';
    return textRoot(zh || block.en || '',block.id,'zh',block);
  }
  function renderPaper() {
    const meta=active.paper.meta;
    $('#app').innerHTML='<div class="reader-actions"><button data-act="library">← 文献库</button><button data-act="bilingual">'+(settings.bilingual?'仅中文':'原文对照')+'</button><button data-act="original">原页</button><button data-act="type">Aa</button></div>'+
      '<h1 class="reader-title">'+E(title(active))+'</h1><p class="reader-meta">'+E(meta.authors || '')+' · '+E(meta.page_count || (meta.pages || []).length || '?')+' 页'+(active.demo?' · 简短界面示例，非完整译文':'')+'</p>'+
      '<article id="paper" class="reader-paper">'+active.paper.blocks.map(b=>'<section class="blk" id="b-'+E(b.id)+'" data-block="'+E(b.id)+'">'+(b.page?'<div class="pg">p.'+E(b.page)+'</div>':'')+content(b)+'</section>').join('')+'</article>';
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
    const draft=existing || {...(selection || {}),anchor:(selection || {}).anchor || (active.reader.progress || {}).block || active.paper.blocks[0].id};
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
      '<section class="settings-group"><h3>Google 云盘</h3><p id="driveState">'+(D.connected?E(D.account.emailAddress || D.account.displayName)+' · 已连接':'连接后，两端可共享论文和批注。资料保存在你自己的云盘，离线阅读不需要登录。')+'</p><div class="actions"><button class="primary" id="driveLogin">'+(D.connected?'切换账号':'连接 Google 云盘')+'</button><button class="secondary" id="driveSync" '+(!D.connected?'disabled':'')+'>立即同步</button></div><p>云端论文按需下载，不会自动下载整个资料库。模型密钥不参与同步。</p><details><summary class="small muted">Google 授权配置</summary><label for="googleClientId">网页客户端 ID</label><input id="googleClientId" autocapitalize="none" spellcheck="false" placeholder="…apps.googleusercontent.com" value="'+E(settings.googleClientId || '')+'"><button id="saveClient" class="secondary">保存配置</button><p>此 ID 是应用的公开登录标识，不是 API Key。首次接入需要在 Google Cloud 中创建一次。</p></details></section>'+
      '<section class="settings-group"><h3>离线与备份</h3><p>下载后的论文、图片和批注保存在此设备。清除 Safari 的网站数据会移除本机副本；请先同步或导出备份。</p><div class="actions"><button class="secondary" data-act="backup">导出当前论文</button><button class="secondary" data-act="import">导入阅读文件</button></div><p id="offlineState">正在检查离线阅读资源…</p></section>'+
      '<section class="settings-group"><h3>添加到 iPhone 主屏幕</h3><p class="install-note">用 Safari 打开手机阅读网址，点分享，再选「添加到主屏幕」。第一次下载论文后，离线也能打开阅读。需要 HTTPS 网址。</p></section>';
    $('#theme').value=settings.theme;
    $('#theme').onchange=async e=>{settings.theme=e.target.value;applyAppearance();await S.setting('appearance',settings);};
    $('#saveClient').onclick=async()=>{const id=$('#googleClientId').value.trim();if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) return toast('客户端 ID 格式不正确');settings.googleClientId=id;await S.setting('appearance',settings);D.loadIdentity().catch(()=>{});toast('Google 登录配置已保存');};
    $('#driveLogin').onclick=async()=>{try {await D.login(settings.googleClientId);cloudFiles=await D.list();preferences();toast('Google 云盘已连接');}catch(error){toast(error.message);}};
    $('#driveSync').onclick=async()=>{try{$('#driveSync').disabled=true;cloudFiles=await D.syncAll((i,n)=>{$('#driveState').textContent='正在同步 '+i+' / '+n+' 篇';});papers=await S.all();if(active) active=await S.get(active.paper_id);preferences();toast('同步完成');}catch(error){preferences();toast(error.message);}};
    if(settings.googleClientId && navigator.onLine) D.loadIdentity().catch(()=>{});
    offlineStatus();
  }
  async function offlineStatus() {
    const el=$('#offlineState');if(!el) return;
    if(!('serviceWorker' in navigator) || !isSecureContext) {el.textContent='离线启动需要 HTTPS 或本机预览环境。';return;}
    const registration=await navigator.serviceWorker.getRegistration();
    el.textContent=registration && registration.active?'离线启动资源已就绪。':'离线启动资源正在准备，请稍后重新打开。';
  }
  async function importFile(file) {
    if(file.size>C.MAX_BYTES) throw new Error('阅读文件超过 64 MB。');
    const data=C.parseImport(await file.text());
    await S.importBundle(data);papers=await S.all();await openPaper(data.paper_id);toast('论文已下载到设备，可离线阅读');
    if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
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
  function downloadJson(value,name) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  document.addEventListener('click',async e=>{
    try {
      const viewButton=e.target.closest('[data-view]');if(viewButton) {papers=await S.all();return setView(viewButton.dataset.view);}
      const open=e.target.closest('[data-open]');if(open) return openPaper(open.dataset.open);
      const remote=e.target.closest('[data-cloud]');if(remote) {remote.disabled=true;const file=cloudFiles.find(f=>f.id===remote.dataset.cloud);const data=await D.getPaper(file,cloudFiles);await S.save(data);papers=await S.all();await openPaper(data.paper_id);return toast('论文已下载，可离线阅读');}
      const size=e.target.closest('[data-size]');if(size) {settings.font=Math.max(15,Math.min(26,Number(settings.font)+Number(size.dataset.size)));applyAppearance();await S.setting('appearance',settings);if($('#fontValue')) $('#fontValue').textContent=settings.font;return;}
      const resolved=e.target.closest('[data-resolve]');if(resolved){active=await S.get(resolved.dataset.paper);const note={...active.reader.notes[resolved.dataset.resolve],updated:new Date().toISOString()};delete note._syncConflicts;active=await S.commit(active.paper_id,[{op:'note',note,resolve_conflicts:true}]);if($('#sheet').open)paperNotes();else allNotes();return;}
      const color=e.target.closest('[data-color]');if(color) return await addHighlight(color.dataset.color);
      const note=e.target.closest('[data-note]');if(note) {if(note.dataset.paper) active=await S.get(note.dataset.paper);if($('#sheet').open) closeSheet();return noteEditor(note.dataset.note);}
      const jump=e.target.closest('[data-jump]');if(jump) {closeSheet();return openPaper(jump.dataset.paper,jump.dataset.jump);}
      const image=e.target.closest('[data-image]');if(image) return sheet('论文插图','<img class="original-page" alt="论文插图" src="'+E(active.images[image.dataset.image])+'">');
      const act=e.target.closest('[data-act]');if(!act) return;
      if(act.dataset.act==='import') $('#importFile').click();
      if(act.dataset.act==='demo') await demo();
      if(act.dataset.act==='library') {papers=await S.all();setView('library');}
      if(act.dataset.act==='paperNotes') paperNotes();
      if(act.dataset.act==='addNote') {closeSheet();noteEditor();}
      if(act.dataset.act==='bilingual') {settings.bilingual=!settings.bilingual;await S.setting('appearance',settings);renderPaper();}
      if(act.dataset.act==='type') sheet('字号与主题','<div class="setting-row"><span>字号</span><div><button data-size="-1">A−</button> <span id="fontValue">'+settings.font+'</span> <button data-size="1">A＋</button></div></div><p class="muted small">主题可以在设置中选择浅色、深色或跟随系统。</p>');
      if(act.dataset.act==='toc') sheet('文章目录',active.paper.blocks.filter(b=>b.type==='heading').map(b=>'<button class="toc-item" data-jump="'+E(b.id)+'" data-paper="'+E(active.paper_id)+'">'+E(b.zh || b.en)+'</button>').join('') || '<p class="muted">这篇论文还没有章节目录。</p>');
      if(act.dataset.act==='original') {const pages=active.paper.meta.pages || [];sheet('原文页面',pages.filter(p=>active.images[p.img]).map(p=>'<p class="muted small">第 '+E(p.n)+' 页</p><img class="original-page" src="'+E(active.images[p.img])+'" alt="原文第 '+E(p.n)+' 页" loading="lazy">').join('') || '<p class="muted">此阅读文件不包含原页图片。请从电脑版导出完整离线阅读文件。</p>');}
      if(act.dataset.act==='backup') {if(!active) return toast('先打开一篇论文，再导出阅读文件');downloadJson(C.normalize(active),title(active).replace(/[\\/:*?"<>|]/g,'')+'.folio.json');toast('已导出论文与当前批注');}
      if(act.dataset.act==='find') {sheet('查找正文','<input id="findInput" type="search" class="search" placeholder="输入关键词" aria-label="查找关键词"><div id="findResults"></div>');$('#findInput').oninput=()=>{const query=$('#findInput').value.trim().toLowerCase();$('#findResults').innerHTML=query?active.paper.blocks.filter(b=>JSON.stringify(b).toLowerCase().includes(query)).map(b=>'<button class="find-match" data-jump="'+E(b.id)+'" data-paper="'+E(active.paper_id)+'">'+E(PR.plain(b.zh || b.caption_zh || b.en || '').slice(0,120))+'<small>p.'+E(b.page || '?')+'</small></button>').join('') || '<p class="muted">没有找到相关文字。</p>':'';};$('#findInput').focus();}
    } catch(error) {toast(error.message);}
  });
  $('#home').onclick=e=>{e.preventDefault();S.all().then(data=>{papers=data;setView('library');}).catch(error=>toast(error.message));};
  $('#importButton').onclick=()=>$('#importFile').click();
  $('#importFile').onchange=async e=>{const file=e.target.files[0];if(file) {try{await importFile(file);}catch(error){toast(error.message);}}e.target.value='';};
  $('#sheetClose').onclick=closeSheet;
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
  window.addEventListener('online',()=>toast('已联网，可以连接 Google 云盘并同步批注'));
  setInterval(async()=>{
    if(!D.connected || D.syncing || !navigator.onLine || document.hidden) return;
    try{cloudFiles=await D.syncAll();papers=await S.all();
      if(view==='library')library();
      if(view==='reader' && active && getSelection().isCollapsed && !$('#sheet').open){
        const fresh=await S.get(active.paper_id),changed=C.canonical(active.reader.notes)!==C.canonical(fresh.reader.notes);
        active=fresh;if(changed){const y=window.scrollY;renderPaper();window.scrollTo(0,y);}
      }
    }catch(error){toast(error.message);}
  },60000);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyAppearance);
  (async()=>{
    settings={theme:'auto',font:18,bilingual:false,...await S.setting('appearance')};
    if(!settings.googleClientId) {
      const config=await fetch('./config.json').then(r=>r.ok?r.json():{}).catch(()=>({}));
      if(config.google_web_client_id) settings.googleClientId=config.google_web_client_id;
    }
    applyAppearance();papers=await S.all();setView('library');
    if('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js').then(reg=>{
      if(reg.waiting) toast('手机阅读资源有更新，关闭后重新打开即可使用');
      navigator.serviceWorker.addEventListener('controllerchange',offlineStatus);
    }).catch(()=>toast('离线启动资源尚未准备好，当前仍可在线阅读'));
  })().catch(error=>{$('#app').innerHTML='<h1>设备存储未就绪</h1><p>'+E(error.message)+'</p>';});
})();
