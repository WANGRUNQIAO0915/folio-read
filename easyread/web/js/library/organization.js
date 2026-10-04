/* Logical library folders and reviewed, explicit-opt-in classification. */
(function (PR) {
  'use strict';
  const L = PR.lib, E = PR.esc, dlg = PR.$('#organizationDlg');
  const post = (path, body) => PR.api(path, {method:'POST', body});
  const title = i => i.display_title || i.title_zh || i.title_en || i.id;
  const folders = () => Object.values(L.organization.folders || {}).filter(f => !f.deleted).sort((a,b)=>a.name.localeCompare(b.name, 'zh'));
  L.folderLabel = id => id ? (L.organization.folders[id]?.deleted ? '' : L.organization.folders[id]?.name || '') : '未分类';
  L.folderOptions = selected => '<option value="">未分类</option>' + folders().map(f => '<option value="'+E(f.id)+'"'+(f.id===selected?' selected':'')+'>'+E(f.name)+'</option>').join('');
  L.folderSidebar = () => '<h3>文件夹<button class="h-add" data-folder-create title="新建文件夹">'+PR.icon('plus','sm')+'</button></h3><div class="sgroup">'+
    '<button class="srow'+(L.folder===null?' on':'')+'" data-folder="">'+PR.icon('folder','sm')+'<span class="t">未分类</span><span class="n">'+L.items.filter(i=>!i.folder_id).length+'</span></button>'+
    folders().map(f=>'<div class="srow'+(L.folder===f.id?' on':'')+'" data-folder="'+E(f.id)+'" role="button" tabindex="0">'+PR.icon('folder','sm')+'<span class="t">'+E(f.name)+'</span><span class="n">'+L.items.filter(i=>i.folder_id===f.id).length+'</span><button class="folder-more" data-folder-more="'+E(f.id)+'" aria-label="管理文件夹 '+E(f.name)+'">'+PR.icon('more','sm')+'</button></div>').join('')+
    '<button class="srow hint-row" data-folder-create>'+PR.icon('plus','sm')+'新建文件夹</button></div>';
  L.organizationDetail = i => '<div class="organization-detail"><span>'+PR.icon('folder','sm')+E(L.folderLabel(i.folder_id))+'</span><button class="btn sm line" data-organize-paper="'+E(i.id)+'">移动 / AI 分类</button></div>';
  L.refreshOrganizationToolbar = () => {
    PR.$('#batchSelect').textContent = L.selecting ? '取消选择' : '选择论文';
    const b=PR.$('#organizeBtn'); b.hidden=!L.selecting; b.disabled=!L.batch.size; b.textContent='整理分类'+(L.batch.size?'（'+L.batch.size+'）':'');
  };
  PR.$('#batchSelect').onclick=()=>{L.selecting=!L.selecting;L.batch.clear();L.render();};
  PR.$('#organizeBtn').onclick=()=>L.openOrganization([...L.batch]);
  PR.$('#list').addEventListener('change',e=>{const id=e.target.dataset.batch;if(!id)return;if(e.target.checked)L.batch.add(id);else L.batch.delete(id);L.refreshOrganizationToolbar();});
  PR.$('#detail').addEventListener('click',e=>{const b=e.target.closest('[data-organize-paper]');if(b)L.openOrganization([b.dataset.organizePaper]);});

  async function createFolder() {
    const name=await PR.promptText({title:'新建文献文件夹',placeholder:'例如：城市热环境',max:80});if(!name)return;
    try{await post('/api/organization/folder',{name});await L.load();PR.toast('文件夹已创建');}catch(e){PR.toast(E(e.message));}
  }
  function folderMenu(id,where) {
    const f=L.organization.folders[id];if(!f||f.deleted)return;
    PR.menu(where,[{label:'重命名文件夹',icon:'edit',fn:async()=>{
      const name=await PR.promptText({title:'重命名文件夹',value:f.name,max:80});if(!name)return;
      try{await post('/api/organization/folder',{id,name});await L.load();}catch(e){PR.toast(E(e.message));}
    }},{label:'删除文件夹',icon:'trash',fn:async()=>{
      if(!await PR.confirm({title:'删除“'+f.name+'”？',body:'只删除软件中的文件夹，论文、PDF 和标签都会保留；其中论文回到“未分类”。同步后其他设备也会更新。',ok:'删除文件夹',danger:true}))return;
      try{await post('/api/organization/folder-delete',{id});if(L.folder===id)L.folder=null;await L.load();PR.toast('文件夹已删除，论文和 PDF 已保留');}catch(e){PR.toast(E(e.message));}
    }}]);
  }
  const side=PR.$('#side');
  side.addEventListener('click',e=>{
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

  let session=0, state=null, focusBefore=null;
  function shell(body) {
    dlg.querySelector('.dialog').innerHTML='<div class="organization-head"><h2>整理文献分类</h2><button class="btn icon" data-org-close aria-label="关闭分类窗口">'+PR.icon('x','sm')+'</button></div>'+body;
  }
  async function close() {
    if(state?.applying)return;
    const old=state;state=null;session++;dlg.classList.remove('open');
    if(old?.preview?.id)post('/api/classification/cancel',{id:old.preview.id}).catch(()=>{});
    focusBefore?.focus();
  }
  L.openOrganization = function(ids) {
    if(state)return;
    const selected=[...new Set(ids)].map(id=>L.byId(id)).filter(Boolean);
    if(!selected.length)return PR.toast('请先选择论文');
    if(selected.length>100)return PR.toast('每次最多整理 100 篇论文');
    focusBefore=document.activeElement;
    state={allowNewFolders:false,ids:selected.map(i=>i.id),drafts:selected.map(i=>({paper_id:i.id,title:title(i),folder_id:i.folder_id||null,tags:[...(i.tags||[])],expected_version:L.organization.assignments[i.organization_id || i.id]?.version || null}))};
    session++;dlg.classList.add('open');renderEdit();
    PR.$('[data-org-close]',dlg).focus();
  };
  function renderEdit(message) {
    if(!state)return;
    shell('<p class="hint">文件夹用于大的研究主题，标签用于具体内容。AI 每篇最多建议 4 个标签，按需给出、不凑数量，优先复用已有分类名称；手动标签可以自行增减。这里只整理分类，不移动原始 PDF。</p>'+
      (message?'<p class="org-message" role="status">'+E(message)+'</p>':'')+
      '<div class="org-batch"><label>统一文件夹 <select class="input" id="orgBatchFolder"><option value="__keep__">保持各自位置</option>'+L.folderOptions()+'</select></label><button class="btn sm line" id="orgBatchSet">应用到下方</button></div>'+
      '<div class="org-paper-list">'+state.drafts.map((d,n)=>'<section class="org-paper" data-org-index="'+n+'"><h3>'+E(d.title)+'</h3>'+
        '<label>文件夹<select class="input" data-org-folder>'+L.folderOptions(d.folder_id)+'<option value="__new__"'+(d.folder_name?' selected':'')+'>新建文件夹…</option></select></label>'+
        '<label data-org-new'+(d.folder_name?'':' hidden')+'>新文件夹名<input class="input" data-org-name maxlength="80" value="'+E(d.folder_name||'')+'"></label>'+
        '<label>标签（用逗号分隔）<input class="input" data-org-tags value="'+E(d.tags.join(', '))+'" maxlength="251000"></label>'+
        (d.reason?'<p class="hint">AI 建议理由：'+E(d.reason)+'</p>':'')+'</section>').join('')+'</div>'+
      '<label class="check"><input type="checkbox" id="orgAllowNewFolders"'+(state.allowNewFolders?' checked':'')+'>允许 AI 建议新文件夹（本批最多 1 个）</label>'+
      '<p class="org-error" id="orgError" role="alert"></p><div class="actions"><button class="btn line" id="orgAI"'+(state.ids.length>20?' disabled':'')+'>AI 建议分类'+(state.ids.length>20?'（每批最多 20 篇）':'')+'</button><span class="grow"></span><button class="btn" data-org-close>取消</button><button class="btn accent" id="orgSave">确认应用分类</button></div>');
  }
  function collect() {
    PR.$$('[data-org-index]',dlg).forEach(row=>{
      const d=state.drafts[Number(row.dataset.orgIndex)],value=PR.$('[data-org-folder]',row).value;
      d.folder_id=value==='__new__'?null:value||null;delete d.folder_name;
      if(value==='__new__'){d.folder_name=PR.$('[data-org-name]',row).value.trim();if(!d.folder_name)throw new Error('请填写新文件夹名称');}
      const tagText=PR.$('[data-org-tags]',row).value;
      if(tagText!==d.tags.join(', '))d.tags=[...new Set(tagText.split(/[,，;；]/).map(t=>t.trim()).filter(Boolean))];
    });
  }
  async function preview() {
    if(!state||state.busy)return;const current=state,seq=session;
    try{
      collect();current.allowNewFolders=PR.$('#orgAllowNewFolders').checked;current.busy=true;PR.$('#orgAI').disabled=true;
      const p=await post('/api/classification/preview',{paper_ids:current.ids,allow_new_folders:current.allowNewFolders});
      if(seq!==session){if(p.id)post('/api/classification/cancel',{id:p.id}).catch(()=>{});return;}
      current.preview=p;current.busy=false;
      shell('<h3>先确认发送范围</h3><p>仅在你勾选并点击下方按钮后，才会向配置的模型发送这些内容。模型只给出建议，不会直接改动分类。</p>'+
        '<dl class="org-provider"><dt>服务商</dt><dd>'+E(p.provider)+'</dd><dt>目的地址</dt><dd>'+E(p.endpoint)+'</dd><dt>模型</dt><dd>'+E(p.model)+'</dd></dl>'+
        '<p class="hint">每篇按需给出 0–4 个 AI 标签，不凑数量；'+(p.allow_new_folders?'本批最多建议 1 个新文件夹。':'只选已有文件夹，不建议新建。')+'</p>'+
        '<p>将发送所选 '+current.ids.length+' 篇论文的标题、摘要和有限正文片段，以及已有分类标签和可选文件夹名称。不会发送原始 PDF、图片、笔记或整篇正文。</p>'+
        '<details open><summary>查看将发送的完整文本</summary><pre class="org-payload">'+E(p.prompt || JSON.stringify(p.messages || {papers:p.papers,folders:p.folders},null,2))+'</pre></details>'+
        '<label class="check org-consent"><input type="checkbox" id="orgConsent">我同意将以上文本发送到此模型服务</label><p class="org-error" id="orgError" role="alert"></p>'+
        '<div class="actions"><button class="btn" id="orgBack">返回修改</button><button class="btn" data-org-close>取消</button><button class="btn accent" id="orgSend" disabled>发送并生成建议</button></div>');
    }catch(e){if(seq===session){current.busy=false;renderEdit();PR.$('#orgError').textContent=e.message;}}
  }
  async function send() {
    if(!state||state.busy||!PR.$('#orgConsent')?.checked)return;
    const current=state,seq=session;current.busy=true;
    PR.$('#orgSend').disabled=true;PR.$('#orgBack').disabled=true;PR.$('#orgConsent').disabled=true;PR.$('#orgError').textContent='正在生成建议…可以关闭窗口取消；不会自动应用。';
    try{
      const result=await post('/api/classification/send',{id:current.preview.id,confirmed:true});
      if(seq!==session)return;
      current.busy=false;
      const suggestions=new Map((result.suggestions || []).map(s=>[s.paper_id,s]));
      current.drafts=current.drafts.map(d=>{const item=L.byId(d.paper_id),s=suggestions.get(d.paper_id)||suggestions.get(item?.organization_id);return s?{...d,folder_id:s.folder_id||null,folder_name:s.folder_id?undefined:s.folder_name||undefined,tags:s.tags||[],reason:s.reason||''}:d;});
      renderEdit('AI 建议已生成，尚未保存。请逐篇检查或修改，然后点击“确认应用分类”。');
    }catch(e){if(seq===session){current.busy=false;renderEdit();PR.$('#orgError').textContent='生成失败：'+e.message+'。原分类未改变。';}}
  }
  async function save() {
    if(!state||state.busy||state.applying)return;const current=state;
    try{collect();current.applying=true;PR.$('#orgSave').disabled=true;
      const assignments=current.drafts.map(({paper_id,folder_id,folder_name,tags,expected_version})=>({paper_id,folder_id,...(folder_name?{folder_name}:{}),tags,expected_version}));
      await post('/api/organization/assign',{assignments});current.applying=false;
      await close();await L.load();PR.toast('分类已保存，原 PDF 保持不变');
    }catch(e){current.applying=false;if(state===current){PR.$('#orgSave').disabled=false;PR.$('#orgError').textContent=e.message;}}
  }
  dlg.addEventListener('change',e=>{
    if(e.target.id==='orgConsent')PR.$('#orgSend').disabled=!e.target.checked;
    if(e.target.matches('[data-org-folder]'))PR.$('[data-org-new]',e.target.closest('[data-org-index]')).hidden=e.target.value!=='__new__';
  });
  dlg.addEventListener('click',e=>{
    if(e.target===dlg||e.target.closest('[data-org-close]'))return close();
    if(e.target.id==='orgAI')return preview();if(e.target.id==='orgSend')return send();if(e.target.id==='orgSave')return save();
    if(e.target.id==='orgBack'){if(state.busy)return;if(state.preview?.id)post('/api/classification/cancel',{id:state.preview.id}).catch(()=>{});state.preview=null;renderEdit();}
    if(e.target.id==='orgBatchSet'){const value=PR.$('#orgBatchFolder').value;if(value==='__keep__')return;try{collect();state.drafts.forEach(d=>{d.folder_id=value||null;delete d.folder_name;});renderEdit();}catch(error){PR.$('#orgError').textContent=error.message;}}
  });
  dlg.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.stopPropagation();close();}
    if(e.key==='Tab'){const f=PR.$$('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary',dlg).filter(el=>el.offsetParent!==null);const first=f[0],last=f.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  });
})(window.PR);
