(function(PR){
  'use strict';
  let timer;const E=PR.esc;
  async function load(s){try{s.scholar=await PR.api('/api/easyscholar');if(s.tab==='scholar'&&PR.$('#settingsDlg').classList.contains('open'))PR.settingsRender();if(s.scholar.busy)timer=setTimeout(()=>load(s),1500);}catch(e){PR.toast(E(e.message));}}
  async function save(s){if(!s.scholarDraft)return; s.scholar=await PR.api('/api/easyscholar/config',{method:'POST',body:s.scholarDraft});s.scholarDraft=null;}
  PR.settingsTabs.scholar={
    render(s){
      if(!s.scholar){clearTimeout(timer);load(s);return '<p class="set-lead">正在读取期刊分区设置…</p>';}
      const d=s.scholar,v=s.scholarDraft||{};
      return '<p class="set-lead">用 easyScholar 查看中科院、JCR 分区与影响因子。</p><p class="hint">'+E(d.message || (d.configured?'SecretKey 已保存在本机':'尚未填写 SecretKey'))+'</p>'+(d.error?'<p class="hint bad">'+E(d.error)+'</p>':'')+
        '<label class="field"><span>EasyScholar SecretKey'+(d.configured?'（留空保留）':'')+'</span><input class="input" id="scholarKey" type="password" autocomplete="off" value="'+E(v.secret_key||'')+'" placeholder="从 easyScholar 开放接口页面获取" '+(d.busy?'disabled':'')+'></label><p class="hint">密钥只保存在本机；查询时仅把期刊名称发给 easyScholar。手机和 Google 云盘只接收分区结果。</p>'+
        '<label class="check"><input type="checkbox" id="scholarAuto" '+((v.auto_lookup??d.auto_lookup)?'checked':'')+' '+(d.busy?'disabled':'')+'>打开文献库时自动查询期刊分区</label><p class="hint">同一期刊优先使用缓存。预印本和未填写期刊的论文会跳过。接口未提供分区数据年份。</p>'+
        '<div class="actions"><button class="btn primary" data-scholar="save" '+(d.busy?'disabled':'')+'>保存接口设置</button><button class="btn" data-scholar="refresh" '+(d.busy?'disabled':'')+'>查询整个文献库</button><button class="btn" data-scholar="clear" '+(!d.configured||d.busy?'disabled':'')+'>移除本机密钥</button></div><p class="hint"><a href="https://www.easyscholar.cc/console/user/open" target="_blank" rel="noopener noreferrer">easyScholar 开放接口与 SecretKey ↗</a></p>';
    },
    sync(s,dlg){const key=dlg.querySelector('#scholarKey'),auto=dlg.querySelector('#scholarAuto');if(key&&!key.disabled)s.scholarDraft={secret_key:key.value.trim(),auto_lookup:auto.checked};},
    save,
    async click(e,s,dlg){const b=e.target.closest('[data-scholar]');if(!b)return false;this.sync(s,dlg);b.disabled=true;try{if(b.dataset.scholar==='clear'){s.scholar=await PR.api('/api/easyscholar/config',{method:'POST',body:{clear_key:true,auto_lookup:false}});s.scholarDraft=null;}else{await save(s);if(b.dataset.scholar==='refresh'){s.scholar=await PR.api('/api/easyscholar/refresh',{method:'POST',body:{}});clearTimeout(timer);if(s.scholar.busy)timer=setTimeout(()=>load(s),1500);}else PR.toast('期刊分区接口设置已保存');}}catch(err){PR.toast(E(err.message));}return true;}
  };
  document.addEventListener('click',async e=>{
    const b=e.target.closest('[data-journal-lookup]');if(!b)return;const input=b.closest('.journal-panel').querySelector('[data-journal-name]');b.disabled=true;
    try{const data=await PR.api('/api/easyscholar/lookup',{method:'POST',body:{paper_id:b.dataset.journalLookup,publication_name:input.value.trim(),force:true}});if(PR.lib)await PR.lib.load();else{PR.state.paper.meta.venue=data.journal_rank.publication;PR.state.item.meta_override={...PR.state.item.meta_override,venue:data.journal_rank.publication};PR.state.paper.meta.journal_rank=data.journal_rank;PR.rerenderKeepingPlace();}PR.toast('期刊分区已更新');}
    catch(err){PR.toast(E(err.message));}finally{b.disabled=false;}
  });
})(window.PR);
