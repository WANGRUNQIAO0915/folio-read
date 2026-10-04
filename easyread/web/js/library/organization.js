/* Hierarchical library folders and editable automatic classification suggestions. */
(function (PR) {
  'use strict';
  const L = PR.lib, E = PR.esc, dlg = PR.$('#organizationDlg');
  const post = (path, body) => PR.api(path, {method:'POST', body});
  const title = i => i.display_title || i.title_zh || i.title_en || i.id;
  const folders = () => window.FolioOrganization.tree(L.organization);
  const collapsed = new Set(PR.ls.get('folio-folder-collapsed', []));
  L.folderLabel = id => id ? window.FolioOrganization.path(L.organization,id) : '未分类';
  L.folderOptions = selected => '<option value="">未分类</option>' + folders().map(f => '<option value="'+E(f.id)+'"'+(f.id===selected?' selected':'')+'>'+E(f.path)+'</option>').join('');
  L.folderSidebar = () => {
    const O=window.FolioOrganization,tree=folders(),hidden=new Set();
    return '<h3>文件夹<button class="h-add" data-folder-create title="新建文件夹">'+PR.icon('plus','sm')+'</button></h3><div class="sgroup folder-tree">'+
      '<button class="srow'+(L.folder===null?' on':'')+'" data-folder="">'+PR.icon('folder','sm')+'<span class="t">未分类</span><span class="n">'+L.items.filter(i=>!i.folder_id).length+'</span></button>'+
      tree.map(f=>{
        if(hidden.has(f.parent_id)){hidden.add(f.id);return '';}
        const children=tree.some(c=>c.parent_id===f.id),shut=collapsed.has(f.id);
        if(shut)hidden.add(f.id);
        return '<div class="srow folder-row'+(L.folder===f.id?' on':'')+'" data-folder="'+E(f.id)+'" role="button" tabindex="0" style="--depth:'+f.depth+'" title="'+E(f.path)+'">'+
          (children?'<button class="folder-toggle" data-folder-toggle="'+E(f.id)+'" aria-expanded="'+!shut+'" aria-label="'+(shut?'展开':'收起')+E(f.name)+'">'+(shut?'▸':'▾')+'</button>':'<span class="folder-toggle-spacer"></span>')+
          PR.icon('folder','sm')+'<span class="t">'+E(f.name)+'</span><span class="n">'+L.items.filter(i=>O.within(L.organization,i.folder_id,f.id)).length+'</span><button class="folder-more" data-folder-more="'+E(f.id)+'" aria-label="管理文件夹 '+E(f.name)+'">'+PR.icon('more','sm')+'</button></div>';
      }).join('')+'<button class="srow hint-row" data-folder-create>'+PR.icon('plus','sm')+'新建文件夹</button></div>';
  };
  L.organizationDetail = i => '<div class="organization-detail"><span>'+PR.icon('folder','sm')+E(L.folderLabel(i.folder_id))+'</span><button class="btn sm line" data-organize-paper="'+E(i.id)+'">移动 / AI 分类</button></div>';
  L.refreshOrganizationToolbar = () => {
    PR.$('#batchSelect').textContent = L.selecting ? '取消选择' : '选择论文';
    const b=PR.$('#organizeBtn'); b.hidden=!L.selecting; b.disabled=!L.batch.size; b.textContent='整理分类'+(L.batch.size?'（'+L.batch.size+'）':'');
  };
  PR.$('#batchSelect').onclick=()=>{L.selecting=!L.selecting;L.batch.clear();L.render();};
  PR.$('#organizeBtn').onclick=()=>L.openOrganization([...L.batch]);
  PR.$('#list').addEventListener('change',e=>{const id=e.target.dataset.batch;if(!id)return;if(e.target.checked)L.batch.add(id);else L.batch.delete(id);L.refreshOrganizationToolbar();});
  PR.$('#detail').addEventListener('click',e=>{const b=e.target.closest('[data-organize-paper]');if(b)L.openOrganization([b.dataset.organizePaper]);});

  async function createFolder(parent_id=null) {
    const name=await PR.promptText({title:parent_id?'在“'+L.folderLabel(parent_id)+'”中新建子文件夹':'新建文献文件夹',placeholder:'例如：城市热环境',max:80});if(!name)return;
    try{await post('/api/organization/folder',{name,parent_id});collapsed.delete(parent_id);PR.ls.set('folio-folder-collapsed',[...collapsed]);await L.load();PR.toast('文件夹已创建');}catch(e){PR.toast(E(e.message));}
  }
  function folderMenu(id,where) {
    const f=L.organization.folders[id];if(!f||f.deleted)return;
    PR.menu(where,[{label:'新建子文件夹',icon:'plus',fn:()=>createFolder(id)},
    {label:'移动到…',icon:'folder',fn:()=>PR.menu(where,[{label:'顶层目录',fn:()=>moveFolder(id,null)},...folders().filter(p=>!window.FolioOrganization.within(L.organization,p.id,id)).map(p=>({label:p.path,fn:()=>moveFolder(id,p.id)}))])},
    {label:'重命名文件夹',icon:'edit',fn:async()=>{
      const name=await PR.promptText({title:'重命名文件夹',value:f.name,max:80});if(!name)return;
      try{await post('/api/organization/folder',{id,name});await L.load();}catch(e){PR.toast(E(e.message));}
    }},{label:'删除文件夹',icon:'trash',fn:async()=>{
      if(!await PR.confirm({title:'删除“'+f.name+'”？',body:'其中直接收录的论文回到“未分类”，子文件夹保留并移到顶层。论文、PDF 和标签都会保留。',ok:'删除文件夹',danger:true}))return;
      try{await post('/api/organization/folder-delete',{id});if(L.folder===id)L.folder=null;await L.load();PR.toast('文件夹已删除，论文和 PDF 已保留');}catch(e){PR.toast(E(e.message));}
    }}]);
  }
  async function moveFolder(id,parent_id){try{await post('/api/organization/folder',{id,name:L.organization.folders[id].name,parent_id});collapsed.delete(parent_id);PR.ls.set('folio-folder-collapsed',[...collapsed]);await L.load();PR.toast('目录已移动');}catch(e){PR.toast(E(e.message));}}
  const side=PR.$('#side');
  side.addEventListener('click',e=>{
    const toggle=e.target.closest('[data-folder-toggle]');if(toggle){const id=toggle.dataset.folderToggle;collapsed.has(id)?collapsed.delete(id):collapsed.add(id);PR.ls.set('folio-folder-collapsed',[...collapsed]);PR.renderSide();return;}
    const more=e.target.closest('[data-folder-more]');if(more){folderMenu(more.dataset.folderMore,more);return;}
    if(e.target.closest('[data-folder-create]'))return createFolder();
    const row=e.target.closest('[data-folder]');if(row){L.folder=row.dataset.folder||null;L.tag=null;L.view='all';L.render();}
  });
  side.addEventListener('keydown',e=>{if(e.target.matches('[data-folder]')&&['Enter',' '].includes(e.key)){e.preventDefault();e.target.click();}});
  side.addEventListener('contextmenu',e=>{const row=e.target.closest('[data-folder]');if(row?.dataset.folder){e.preventDefault();folderMenu(row.dataset.folder,{x:e.clientX,y:e.clientY});}});
  side.addEventListener('dragover',e=>{if(e.target.closest('[data-folder]'))e.preventDefault();});
  side.addEventListener('drop',async e=>{
    const row=e.target.closest('[data-folder]');if(!row)return;
    const i=L.byId(e.dataTransfer.getData('text/plain'));if(!i)return;e.preventDefault();
    try{await post('/api/organization/assign',{assignments:[{paper_id:i.id,folder_id:row.dataset.folder||null}]});await L.load();PR.toast('已移动到“'+E(L.folderLabel(row.dataset.folder))+'”');}catch(err){PR.toast(E(err.message));}
  });

  let session=0,state=null,focusBefore=null;
  const CE=window.FolioClassificationEditor,O=window.FolioOrganization;
  const editorOrg=()=>({...O,state:L.organization});
  const cancelPreview=p=>{if(p?.id)post('/api/classification/cancel',{id:p.id}).catch(()=>{});};
  function stop(){if(!state)return;state.run++;cancelPreview(state.preview);state.preview=null;state.busy=false;update();}
  async function close(){if(state?.applying)return;stop();state=null;session++;dlg.classList.remove('open');focusBefore?.focus();}
  L.openOrganization=function(ids,options={}){
    if(state)return;const selected=[...new Set(ids)].map(id=>L.byId(id)).filter(Boolean);
    if(!selected.length)return PR.toast('请先选择论文');if(selected.length>100)return PR.toast('每次最多整理 100 篇论文');
    focusBefore=document.activeElement;
    state={ids:selected.map(i=>i.id),run:0,busy:false,auto:options.auto??PR.ls.get('folio-classification-auto',true),allowNewFolders:true,
      drafts:selected.map(i=>CE.draft({paper_id:i.id,title:title(i),folder_id:i.folder_id||null,tags:[...(i.tags||[])],expected_version:L.organization.assignments[i.organization_id||i.id]?.version||null}))};
    session++;dlg.classList.add('open');render();PR.$('[data-org-close]',dlg).focus();if(state.auto)generate();
  };
  function render(){
    if(!state)return;
    dlg.querySelector('.dialog').innerHTML='<div class="organization-head"><h2>文件夹与标签</h2><button class="btn icon" data-org-close aria-label="关闭分类窗口">'+PR.icon('x','sm')+'</button></div>'+
      '<p class="hint">淡色文字是建议：留空采用建议，填写则覆盖。文件夹可选择已有目录，也可输入「主题 / 子主题」。</p>'+
      '<div class="org-ai-bar"><label class="check"><input type="checkbox" id="orgAuto"'+(state.auto?' checked':'')+'>打开时自动推荐</label><span id="orgStatus" role="status"></span><button class="btn sm line" id="orgAI">重新推荐</button><button class="btn sm line" id="orgStop" hidden>停止</button></div>'+
      '<details class="org-ai-options"><summary>AI 设置与发送内容</summary><label class="check"><input type="checkbox" id="orgAllowNewFolders" checked>允许建议新主题文件夹（本批最多 1 个）</label><p class="hint">每篇按需推荐 0–4 个标签。仅发送标题、摘要、有限正文和现有分类；建议不会自动保存。</p><div id="orgProvider"></div><pre class="org-payload" id="orgPayload"></pre></details>'+
      '<datalist id="orgFolders">'+O.tree(L.organization).map(f=>'<option value="'+E(f.path)+'"></option>').join('')+'</datalist>'+
      '<div class="org-paper-list">'+state.drafts.map((d,n)=>'<section class="org-paper" data-org-index="'+n+'"><h3>'+E(d.title)+'</h3><div class="org-fields">'+
        '<label>文件夹 <span class="org-source" data-source="folder"></span><input class="input" data-org-folder list="orgFolders" value="'+E(d.folderText)+'" maxlength="1000" autocomplete="off"><span class="org-field-actions"><button type="button" data-org-clear="folder">不设置文件夹</button><button type="button" data-org-reset="folder">使用建议</button></span></label>'+
        '<label>标签 <span class="org-source" data-source="tags"></span><input class="input" data-org-tags value="'+E(d.tagsText)+'" maxlength="251000" autocomplete="off"><span class="org-field-actions"><button type="button" data-org-clear="tags">清空标签</button><button type="button" data-org-reset="tags">使用建议</button></span></label></div><p class="hint" data-org-reason></p></section>').join('')+'</div>'+
      '<p class="org-error" id="orgError" role="alert"></p><div class="actions"><span class="hint">仅保存当前分类，原始 PDF 不移动。</span><span class="grow"></span><button class="btn" data-org-close>取消</button><button class="btn accent" id="orgSave">保存分类</button></div>';
    update();
  }
  function capture(){if(!state)return;PR.$$('[data-org-index]',dlg).forEach(row=>{const d=state.drafts[Number(row.dataset.orgIndex)];d.folderText=PR.$('[data-org-folder]',row).value;d.tagsText=PR.$('[data-org-tags]',row).value;});}
  function update(){
    if(!state)return;PR.$('#orgAI',dlg).disabled=!!state.busy||state.ids.length>20;PR.$('#orgStop',dlg).hidden=!state.busy;PR.$('#orgSave',dlg).disabled=!!state.busy||!!state.applying;
    PR.$('#orgStatus',dlg).textContent=state.busy?'AI 正在推荐…':state.drafts.some(d=>d.suggestion)?'建议已就绪，保存后生效':state.ids.length>20?'AI 一次最多 20 篇，可直接手动整理':'';
    PR.$$('[data-org-index]',dlg).forEach(row=>{const d=state.drafts[Number(row.dataset.orgIndex)];for(const kind of ['folder','tags']){const f=CE.field(d,kind,editorOrg());PR.$('[data-org-'+(kind==='folder'?'folder':'tags')+']',row).placeholder=f.placeholder;PR.$('[data-source="'+kind+'"]',row).textContent=f.value||d[kind==='folder'?'clearFolder':'clearTags']?'手动修改':f.source;}PR.$('[data-org-reason]',row).textContent=d.suggestion?.reason||'';});
  }
  async function generate(){
    if(!state||state.busy||state.ids.length>20)return;const current=state,seq=++current.run;capture();cancelPreview(current.preview);current.preview=null;current.busy=true;PR.$('#orgError',dlg).textContent='';update();
    try{
      const p=await post('/api/classification/preview',{paper_ids:current.ids,allow_new_folders:current.allowNewFolders});
      if(state!==current||current.run!==seq){cancelPreview(p);return;}current.preview=p;
      PR.$('#orgProvider',dlg).textContent=p.provider+' · '+p.model+' · '+p.endpoint;PR.$('#orgPayload',dlg).textContent=p.prompt||JSON.stringify(p.messages||[],null,2);
      const result=await post('/api/classification/send',{id:p.id,confirmed:true});
      if(state!==current||current.run!==seq)return;
      capture();const suggestions=new Map((result.suggestions||[]).map(s=>[s.paper_id,s]));
      current.drafts.forEach(d=>{const s=suggestions.get(d.paper_id)||suggestions.get(L.byId(d.paper_id)?.organization_id);if(s)d.suggestion={...s,tags:s.tags||[]};});
    }catch(e){if(state===current&&current.run===seq)PR.$('#orgError',dlg).textContent='AI 暂时不可用：'+e.message+'。可直接填写并保存，或点击重新推荐。';}
    finally{if(state===current&&current.run===seq){current.busy=false;update();}}
  }
  async function save(){
    if(!state||state.busy||state.applying)return;const current=state;
    try{capture();const assignments=current.drafts.map(d=>CE.resolve(d,editorOrg()));current.applying=true;update();await post('/api/organization/assign',{assignments});current.applying=false;await close();await L.load();PR.toast('分类已保存');}
    catch(e){current.applying=false;if(state===current){update();PR.$('#orgError',dlg).textContent=e.message;}}
  }
  dlg.addEventListener('input',e=>{if(!state)return;const row=e.target.closest('[data-org-index]');if(!row)return;const d=state.drafts[Number(row.dataset.orgIndex)];if(e.target.matches('[data-org-folder]'))d.clearFolder=false;if(e.target.matches('[data-org-tags]'))d.clearTags=false;capture();update();});
  dlg.addEventListener('change',e=>{if(!state)return;if(e.target.id==='orgAuto'){state.auto=e.target.checked;PR.ls.set('folio-classification-auto',state.auto);if(state.auto)generate();else stop();}if(e.target.id==='orgAllowNewFolders'){state.allowNewFolders=e.target.checked;stop();if(state.auto)generate();}});
  dlg.addEventListener('click',e=>{
    if(e.target===dlg||e.target.closest('[data-org-close]'))return close();if(e.target.id==='orgAI')return generate();if(e.target.id==='orgStop')return stop();if(e.target.id==='orgSave')return save();
    const clear=e.target.closest('[data-org-clear]'),reset=e.target.closest('[data-org-reset]');if(!state||(!clear&&!reset))return;const button=clear||reset,row=button.closest('[data-org-index]'),d=state.drafts[Number(row.dataset.orgIndex)],kind=button.dataset.orgClear||button.dataset.orgReset;d[kind==='folder'?'clearFolder':'clearTags']=!!clear;d[kind==='folder'?'folderText':'tagsText']='';PR.$('[data-org-'+(kind==='folder'?'folder':'tags')+']',row).value='';update();
  });
  dlg.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close();}if(e.key==='Tab'){const f=PR.$$('button:not([disabled]),input:not([disabled]),summary',dlg).filter(el=>el.offsetParent!==null),first=f[0],last=f.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}});
})(window.PR);
