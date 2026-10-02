(function(PR) {
  'use strict';
  let timer=null, draftId='',draftSecret='';
  const E=PR.esc;
  PR.settingsTabs.cloud={
    render(s) {
      if(!s.drive){load(s);return '<p class="set-lead">正在读取云同步状态…</p>';}
      const d=s.drive;
      return '<p class="set-lead">把选中的论文、译文、批注和阅读位置带到手机。资料保存在你自己的 Google 云盘。</p>'+
        '<p class="hint">'+E(d.message || (d.connected?'云盘已连接':'尚未连接'))+(d.account?' · '+E(d.account.emailAddress || d.account.displayName):'')+'</p>'+
        (d.error?'<p class="hint bad">'+E(d.error)+'</p>':'')+
        '<div class="actions"><button class="btn primary" data-drive="login" '+(!d.configured || d.busy?'disabled':'')+'>连接 Google 云盘</button><button class="btn" data-drive="sync" '+(!d.configured || d.busy?'disabled':'')+'>立即同步</button><button class="btn" data-drive="refresh">刷新状态</button><button class="btn" data-drive="disconnect" '+(d.busy?'disabled':'')+'>断开本机登录</button></div>'+
        '<p class="hint">连接后，程序运行期间每分钟同步选中的论文。iPhone 中用 Safari 打开 <a href="https://wangrunqiao0915.github.io/folio-read/mobile/" target="_blank" rel="noopener">手机阅读页 ↗</a>，登录同一 Google 账号后按需下载。首次部署与授权配置完成后生效。</p>'+
        '<h3>带到手机的论文</h3><div class="switch-list">'+d.papers.map(p=>'<label class="switch-row"><span>'+E(p.title)+'</span><input type="checkbox" data-cloud-paper="'+E(p.id)+'" '+(p.selected?'checked':'')+' '+(d.busy?'disabled':'')+'></label>').join('')+'</div>'+
        '<div class="actions"><button class="btn" data-drive="select" '+(d.busy?'disabled':'')+'>保存论文选择</button></div>'+
        (d.cloud.length?'<h3>云端阅读副本</h3>'+uniqueCloud(d.cloud).map(f=>'<p>'+E(f.name.replace(/\.folio\.json$/,''))+' <button class="btn sm" data-drive-file="'+E(f.id)+'" '+(d.busy?'disabled':'')+'>下载到 Windows</button></p>').join(''):'')+
        '<details class="settings-sec"><summary>首次接入配置</summary><p class="hint">需要同一 Google Cloud 项目中的“桌面应用”客户端；手机使用该项目的“网页应用”客户端。登录标识与模型 API Key 无关。详见项目的手机同步说明。</p><label class="field"><span>桌面客户端 ID</span><input class="input" id="driveClientId" value="'+E(draftId || d.client_id)+'" placeholder="…apps.googleusercontent.com"></label><label class="field"><span>桌面客户端 Secret（按下载的客户端配置填写）</span><input class="input" id="driveClientSecret" type="password" value="'+E(draftSecret)+'" placeholder="仅存于本机配置"></label><button class="btn" data-drive="config">保存登录配置</button></details>';
    },
    sync(s,dlg){const id=dlg.querySelector('#driveClientId'),secret=dlg.querySelector('#driveClientSecret');if(id)draftId=id.value.trim();if(secret)draftSecret=secret.value;},
    async click(e,s,dlg) {
      const file=e.target.closest('[data-drive-file]');
      if(file){try{s.drive=await PR.api('/api/drive/pull',{method:'POST',body:{file_id:file.dataset.driveFile}});poll(s);}catch(error){PR.toast(E(error.message));}return true;}
      const b=e.target.closest('[data-drive]');if(!b)return false;
      this.sync(s,dlg);const action=b.dataset.drive;let body={};
      if(action==='config')body={client_id:draftId,client_secret:draftSecret};
      if(action==='select')body={ids:[...dlg.querySelectorAll('[data-cloud-paper]:checked')].map(x=>x.dataset.cloudPaper)};
      try{s.drive=await PR.api(action==='refresh'?'/api/drive':'/api/drive/'+action,{method:action==='refresh'?'GET':'POST',body:action==='refresh'?undefined:body});draftSecret='';poll(s);}
      catch(error){PR.toast(E(error.message));}
      return true;
    }
  };
  function uniqueCloud(files){const ids=new Map();for(const f of files){const id=f.appProperties.folioPaperId;const cur=ids.get(id);if(!cur||Date.parse(f.modifiedTime)>Date.parse(cur.modifiedTime))ids.set(id,f);}return [...ids.values()];}
  async function load(s){try{s.drive=await PR.api('/api/drive');if(s.tab==='cloud')PR.settingsRender();poll(s);}catch(e){PR.toast(E(e.message));}}
  function poll(s){clearTimeout(timer);if(s.drive.busy)timer=setTimeout(()=>load(s),1800);}
})(window.PR);
