(function(PR) {
  'use strict';
  let timer=null, draftId='',draftSecret='';
  const E=PR.esc;
  PR.settingsTabs.cloud={
    render(s) {
      if(!s.drive){load(s);return '<p class="set-lead">正在读取云同步状态…</p>';}
      const d=s.drive;
      return '<p class="set-lead">手机与电脑共用你的私有云端文献库。同步原始 PDF、正文、译文、知识索引、批注和阅读位置。</p>'+
        '<p class="hint">'+E(d.message || (d.connected?'云盘已连接':'尚未连接'))+(d.account?' · '+E(d.account.emailAddress || d.account.displayName):'')+'</p>'+
        (d.error?'<p class="hint bad">'+E(d.error)+'</p>':'')+
        '<div class="actions"><button class="btn primary" data-drive="login" '+(!d.configured || d.busy?'disabled':'')+'>连接 Google 云盘</button><button class="btn" data-drive="sync" '+(!d.configured || d.busy?'disabled':'')+'>立即同步</button><button class="btn" data-drive="refresh">刷新状态</button><button class="btn" data-drive="disconnect" '+(d.busy?'disabled':'')+'>断开本机登录</button></div>'+
        '<p class="hint">运行并联网时每分钟同步。另一设备上传的新论文自动进入电脑版资料库和知识检索。iPhone 中用 Safari 打开 <a href="https://wangrunqiao0915.github.io/folio-read/mobile/" target="_blank" rel="noopener">手机应用 ↗</a>，连接同一 Google 账号即可看到共同资料。</p>'+
        '<h3>从云盘文件夹导入 PDF</h3><p class="hint">'+(d.folder_import_enabled?(d.folder_read_granted?'已开启。同步时检查 Folio Read 文件夹内直接放入的 PDF。':'尚需 Google 只读授权，当前普通同步不受影响。'):'默认关闭。开启后，两种导入方式共用同一个文献库。')+'</p>'+
        '<p class="hint">Google 会授予读取整个云盘的权限；应用只扫描 Folio Read 文件夹的直接 PDF，不扫描其他文件夹。解析在设备完成，不自动调用 AI。原文件保持不变；兼容其他设备的副本放在 Folio Read Sources 子文件夹，同一内容复用已有副本，会占用云盘空间。</p>'+
        '<div class="actions"><button class="btn" data-drive="folder-import" data-enabled="true" '+(!d.configured || d.busy?'disabled':'')+'>'+ (d.folder_import_enabled?'重新授权文件夹导入':'开启并授权文件夹导入') +'</button>'+ (d.folder_import_enabled?'<button class="btn" data-drive="folder-import" data-enabled="false" '+(d.busy?'disabled':'')+'>停止扫描文件夹</button>':'') +'</div>'+
        '<h3>资料库范围</h3><label class="switch-row"><span>同步整个资料库（包括以后导入的论文）</span><input type="checkbox" id="cloudSyncAll" '+(d.sync_all?'checked':'')+' '+(d.busy?'disabled':'')+'></label><details '+(!d.sync_all?'open':'')+'><summary>或仅同步所选论文</summary><div class="switch-list">'+d.papers.map(p=>'<label class="switch-row"><span>'+E(p.title)+'</span><input type="checkbox" data-cloud-paper="'+E(p.id)+'" '+(p.selected?'checked':'')+' '+(d.busy?'disabled':'')+'></label>').join('')+'</div></details>'+
        '<div class="actions"><button class="btn" data-drive="select" '+(d.busy?'disabled':'')+'>保存论文选择</button></div>'+
        (d.cloud.length?'<h3>共同云端资料</h3>'+uniqueCloud(d.cloud).map(f=>'<p>'+E(f.name.replace(/\.folio\.json$/,''))+' <button class="btn sm" data-drive-file="'+E(f.id)+'" '+(d.busy?'disabled':'')+'>下载到 Windows</button></p>').join(''):'')+
        '<details class="settings-sec"><summary>首次接入配置</summary><p class="hint">需要同一 Google Cloud 项目中的“桌面应用”客户端；手机使用该项目的“网页应用”客户端。登录标识与模型 API Key 无关。详见项目的手机同步说明。</p><label class="field"><span>桌面客户端 ID</span><input class="input" id="driveClientId" value="'+E(draftId || d.client_id)+'" placeholder="…apps.googleusercontent.com"></label><label class="field"><span>桌面客户端 Secret（按下载的客户端配置填写）</span><input class="input" id="driveClientSecret" type="password" value="'+E(draftSecret)+'" placeholder="仅存于本机配置"></label><button class="btn" data-drive="config">保存登录配置</button></details>';
    },
    sync(s,dlg){const id=dlg.querySelector('#driveClientId'),secret=dlg.querySelector('#driveClientSecret');if(id)draftId=id.value.trim();if(secret)draftSecret=secret.value;},
    async click(e,s,dlg) {
      const file=e.target.closest('[data-drive-file]');
      if(file){try{s.drive=await PR.api('/api/drive/pull',{method:'POST',body:{file_id:file.dataset.driveFile}});poll(s);}catch(error){PR.toast(E(error.message));}return true;}
      const b=e.target.closest('[data-drive]');if(!b)return false;
      this.sync(s,dlg);const action=b.dataset.drive;let body={};
      if(action==='folder-import')body={enabled:b.dataset.enabled==='true'};
      if(action==='config')body={client_id:draftId,client_secret:draftSecret};
      if(action==='select')body={ids:[...dlg.querySelectorAll('[data-cloud-paper]:checked')].map(x=>x.dataset.cloudPaper),sync_all:dlg.querySelector('#cloudSyncAll').checked};
      try{s.drive=await PR.api(action==='refresh'?'/api/drive':'/api/drive/'+action,{method:action==='refresh'?'GET':'POST',body:action==='refresh'?undefined:body});draftSecret='';poll(s);}
      catch(error){PR.toast(E(error.message));}
      return true;
    }
  };
  function uniqueCloud(files){const ids=new Map();for(const f of files){const id=f.appProperties.folioPaperId;const cur=ids.get(id);if(!cur||Date.parse(f.modifiedTime)>Date.parse(cur.modifiedTime))ids.set(id,f);}return [...ids.values()];}
  async function load(s){try{s.drive=await PR.api('/api/drive');if(s.tab==='cloud')PR.settingsRender();poll(s);}catch(e){PR.toast(E(e.message));}}
  function poll(s){clearTimeout(timer);if(s.drive.busy)timer=setTimeout(()=>load(s),1800);}
})(window.PR);
