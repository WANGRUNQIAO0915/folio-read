/* Google Identity Services + per-file Drive scope. Tokens stay in memory. */
(function (root) {
  'use strict';
  const C=root.FolioMobile, S=root.FolioStorage;
  const API='https://www.googleapis.com/drive/v3/files';
  const SCOPE='https://www.googleapis.com/auth/drive.file';
  let token='',expires=0,account=null,syncing=false,identity=null;
  async function request(url,options={}) {
    if (!token || Date.now()>=expires) throw new Error('请先点「连接 Google 云盘」完成登录。');
    if (!url.startsWith('https://www.googleapis.com/')) throw new Error('云盘请求地址无效。');
    const response=await fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer '+token}});
    if(!response.ok) {
      if(response.status===401) {token='';throw new Error('Google 登录已过期，请重新连接云盘。');}
      const error=await response.json().catch(()=>({}));
      throw new Error((error.error && error.error.message) || '云盘请求失败，请稍后重试。');
    }
    return response;
  }
  function loadIdentity() {
    if(root.google && root.google.accounts) return Promise.resolve();
    if(identity) return identity;
    identity=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;
      script.onload=resolve;script.onerror=()=>{identity=null;reject(new Error('Google 登录服务未能加载，请检查网络。'));};
      document.head.append(script);
    });
    return identity;
  }
  async function login(clientId) {
    if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId || '')) throw new Error('请先配置 Google 登录客户端 ID。');
    await loadIdentity();
    return new Promise((resolve,reject)=>{
      const client=root.google.accounts.oauth2.initTokenClient({client_id:clientId,scope:SCOPE,include_granted_scopes:false,
        callback:async data=>{
          if(data.error || !data.access_token) return reject(new Error('Google 授权未完成。'));
          if(!root.google.accounts.oauth2.hasGrantedAllScopes(data,SCOPE)) return reject(new Error('请允许访问 Folio Read 创建的云盘文件。'));
          token=data.access_token;expires=Date.now()+Math.max(0,(Number(data.expires_in)||3600)-60)*1000;
          try {
            account=(await (await request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)')).json()).user;
            if(!account || !account.permissionId) throw new Error('未能确认云盘账号。');
            resolve(account);
          } catch(error) {token='';account=null;reject(error);}
        },error_callback:()=>reject(new Error('登录窗口已关闭或无法打开，请在 Safari 中重试。'))});
      client.requestAccessToken({prompt:'select_account'});
    });
  }
  async function list() {
    const files=[];let page='';
    do {
      const params=new URLSearchParams({q:"trashed = false and appProperties has { key='folioApp' and value='mobile-v1' }",pageSize:'1000',fields:'nextPageToken,files(id,name,modifiedTime,size,appProperties)'});
      if(page) params.set('pageToken',page);
      const data=await (await request(API+'?'+params)).json();
      files.push(...(data.files || []));page=data.nextPageToken || '';
    } while(page);
    return files;
  }
  async function upload(name,data,properties,folder) {
    const boundary='folio_'+crypto.randomUUID().replace(/-/g,'');
    const meta={name,mimeType:'application/json',appProperties:{folioApp:'mobile-v1',...properties}};
    if(folder) meta.parents=[folder];
    const body=new Blob(['--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',JSON.stringify(meta),
      '\r\n--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',JSON.stringify(data),'\r\n--'+boundary+'--\r\n']);
    if(body.size>C.MAX_BYTES) throw new Error('这篇论文的阅读文件超过 64 MB。');
    return (await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,appProperties',{
      method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body})).json();
  }
  async function folder(files) {
    const existing=files.filter(f=>f.appProperties.folioType==='folder').sort((a,b)=>a.id.localeCompare(b.id))[0];
    if(existing) return existing.id;
    const result=await (await request(API+'?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Folio Read',mimeType:'application/vnd.google-apps.folder',appProperties:{folioApp:'mobile-v1',folioType:'folder'}})})).json();
    files.push({id:result.id,appProperties:{folioType:'folder'}});return result.id;
  }
  async function download(file) {
    if(!/^[\w-]+$/.test(file.id) || Number(file.size)>C.MAX_BYTES) throw new Error('云盘阅读文件无效或过大。');
    const response=await request(API+'/'+file.id+'?alt=media');
    const text=await response.text();
    if(new TextEncoder().encode(text).length>C.MAX_BYTES) throw new Error('云盘阅读文件超过 64 MB。');
    return JSON.parse(text);
  }
  function latest(files,id) {
    return files.filter(f=>f.appProperties.folioType==='paper' && f.appProperties.folioPaperId===id)
      .sort((a,b)=>C.time(b.modifiedTime)-C.time(a.modifiedTime) || a.id.localeCompare(b.id))[0];
  }
  async function opsFor(files,id) {
    const cacheKey='drive-op-cache:'+account.permissionId;
    const cache=await S.setting(cacheKey) || {}, events=[];
    for(const file of files.filter(f=>f.appProperties.folioType==='ops' && f.appProperties.folioPaperId===id)) {
      let data=cache[file.id];
      if(!data) {
        data=await download(file);
        if(data.schema!==1 || data.paper_id!==id || !Array.isArray(data.ops)) throw new Error('云盘笔记文件不完整，请保留该文件并检查同步记录。');
        cache[file.id]=data;
      }
      events.push(...data.ops);
    }
    await S.setting(cacheKey,cache);return events;
  }
  async function getPaper(file,files) {
    const data=C.normalize(await download(file));
    if(data.paper_id!==file.appProperties.folioPaperId) throw new Error('云盘论文标识不匹配。');
    data.reader=C.materialize([data.reader],await opsFor(files,data.paper_id));
    data.bound_account=account.permissionId;data.pending=[];data.synced_once=true;data.cloud_file_id=file.id;
    return data;
  }
  async function syncPaper(data,files,deviceId) {
    if(data.bound_account && data.bound_account!==account.permissionId) throw new Error('这篇论文已绑定其他 Google 账号，请切回原账号后同步。');
    let remoteFile=latest(files,data.paper_id);
    const parent=await folder(files);
    if(!remoteFile) {
      const bundle=C.normalize(data);
      remoteFile=await upload((bundle.paper.meta.short_zh || bundle.paper.meta.title_zh || '论文').slice(0,60)+'.folio.json',bundle,{folioType:'paper',folioPaperId:data.paper_id},parent);
      files.push(remoteFile);
    }
    const initial=data.synced_once ? []:C.readerEvents(data.reader,deviceId);
    const outgoing=initial.concat(data.pending || []);
    if(outgoing.length) {
      const batch=crypto.randomUUID();
      const entry=await upload('笔记-'+batch+'.json',{schema:1,paper_id:data.paper_id,device_id:deviceId,ops:outgoing},
        {folioType:'ops',folioPaperId:data.paper_id,folioBatch:batch},parent);
      files.push(entry);
    }
    // Refresh after upload: concurrent records are merged instead of replacing a cloud JSON.
    const fresh=await list(), bundle=await getPaper(latest(fresh,data.paper_id),fresh);
    const reader=C.materialize([data.reader,bundle.reader],await opsFor(fresh,data.paper_id));
    const sent=new Set(outgoing.map(op=>op.event_id));
    return S.mergeRemote(data.paper_id,reader,sent,{bound_account:account.permissionId,cloud_file_id:remoteFile.id,
      paper:bundle.paper,images:bundle.images,discussion:bundle.discussion,item:bundle.item});
  }
  const drive={login,loadIdentity,list,getPaper,latest,
    get connected(){return !!token && Date.now()<expires;},get account(){return account;},get syncing(){return syncing;},
    logout(){token='';expires=0;account=null;},
    async syncAll(onProgress) {
      if(syncing) throw new Error('同步正在进行，请稍等。');
      syncing=true;
      try {
        let id=await S.setting('deviceId');if(!id) {id=crypto.randomUUID();await S.setting('deviceId',id);}
        const data=await S.all(), files=await list();
        for(let i=0;i<data.length;i++) {
          if(data[i].demo) continue;
          if(onProgress) onProgress(i+1,data.length);
          await syncPaper(data[i],files,id);
        }
        await S.setting('lastSync',new Date().toISOString());return list();
      } finally {syncing=false;}
    }
  };
  root.FolioDrive=drive;
})(window);
