/* Google Identity Services + per-file Drive scope. Tokens stay in memory. */
(function (root) {
  'use strict';
  const C=root.FolioMobile, S=root.FolioStorage;
  const API='https://www.googleapis.com/drive/v3/files';
  const SCOPE='https://www.googleapis.com/auth/drive.file';
  let token='',expires=0,account=null,syncing=false,identity=null,signingIn=false;
  const nativeAuthorization=()=>typeof root.FolioPlatform?.authorizeDrive==='function';
  async function invalidateToken() {
    const rejected=token;token='';expires=0;account=null;
    if(nativeAuthorization() && typeof root.FolioPlatform.clearDriveToken==='function') {
      try {await root.FolioPlatform.clearDriveToken(rejected);} catch(_) {}
    }
  }
  async function request(url,options={}) {
    if (!token || Date.now()>=expires) throw new Error('请先点「连接 Google 云盘」完成登录。');
    if (!url.startsWith('https://www.googleapis.com/')) throw new Error('云盘请求地址无效。');
    const response=await fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer '+token}});
    if(!response.ok) {
      if(response.status===401) {
        await invalidateToken();
        throw new Error('Google 登录已过期，请重新连接云盘。');
      }
      const error=await response.json().catch(()=>({}));
      throw new Error((error.error && error.error.message) || '云盘请求失败，请稍后重试。');
    }
    return response;
  }
  function loadIdentity() {
    if(nativeAuthorization()) return Promise.resolve();
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
    if(signingIn)throw new Error('Google 授权正在进行，请先完成或关闭当前窗口。');
    if(syncing)throw new Error('云盘同步正在进行，请完成后再切换账号。');
    signingIn=true;
    try {return await authorizeLogin(clientId);} finally {signingIn=false;}
  }
  async function authorizeLogin(clientId) {
    // Android uses Google's native authorization UI, never OAuth inside WebView.
    if(nativeAuthorization()) {
      token='';expires=0;account=null;
      try {
        const accessToken=await root.FolioPlatform.authorizeDrive();
        if(typeof accessToken!=='string' || !accessToken || /\s/.test(accessToken))throw new Error('Google 授权未返回有效登录凭据。');
        // Native tokens can be cached by Play services; HTTP 401 still invalidates them.
        token=accessToken;expires=Date.now()+50*60*1000;
        account=(await (await request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)')).json()).user;
        if(!account || !account.permissionId)throw new Error('未能确认云盘账号。');
        return account;
      } catch(error) {token='';expires=0;account=null;throw error;}
    }
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
  async function uploadSource(source,pid,parent) {
    const blob=source.blob;
    if(!blob || blob.size>128*1024*1024)throw new Error('原始 PDF 缺失或超过 128 MB。');
    const original=new Uint8Array(await blob.arrayBuffer());
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',original))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(digest!==pid || !new TextDecoder().decode(original.slice(0,1024)).includes('%PDF-'))throw new Error('原始 PDF 与论文标识不一致，请重新导入。');
    const meta={name:source.name || '论文.pdf',mimeType:'application/pdf',parents:[parent],appProperties:{folioApp:'mobile-v1',folioType:'source',folioPaperId:pid}};
    const begin=await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,modifiedTime,size,appProperties',{
      method:'POST',headers:{'Content-Type':'application/json','X-Upload-Content-Type':'application/pdf','X-Upload-Content-Length':String(blob.size)},body:JSON.stringify(meta)});
    const session=begin.headers.get('Location');
    if(!session || !session.startsWith('https://www.googleapis.com/upload/drive/'))throw new Error('云盘上传会话无效。');
    let offset=0,retries=0;
    while(offset<blob.size) {
      const end=Math.min(blob.size,offset+4*1024*1024);
      try {
        const response=await fetch(session,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/pdf','Content-Range':'bytes '+offset+'-'+(end-1)+'/'+blob.size},body:blob.slice(offset,end)});
        if(response.ok)return response.json();
        if(response.status===308) {const range=response.headers.get('Range'),next=range?Number(range.split('-').pop())+1:0;if(next<=offset || next>blob.size)throw new Error('云盘未确认本段上传，请重试。');offset=next;retries=0;continue;}
        if(response.status===401){await invalidateToken();throw new Error('Google 登录已过期，请重新连接后重试。');}
        throw new Error('PDF 上传未完成（'+response.status+'），本机原稿仍然保留。');
      } catch(error) {
        if(!token || ++retries>2)throw error;
        const probe=await fetch(session,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Range':'bytes */'+blob.size}});
        if(probe.status===401){await invalidateToken();throw new Error('Google 登录已过期，请重新连接后重试。');}
        if(probe.ok)return probe.json();
        if(probe.status!==308)throw error;
        const range=probe.headers.get('Range');offset=range?Number(range.split('-').pop())+1:0;
      }
    }
    throw new Error('PDF 上传未得到完成确认，请重试。');
  }
  async function hashValue(value) {
    const bytes=new TextEncoder().encode(C.canonical(value));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  const contentHash=data=>hashValue({paper:data.paper,images:data.images,discussion:data.discussion,
    item:Object.fromEntries(['tags','status','starred','rating','meta_override'].filter(k=>Object.hasOwn(data.item || {},k)).map(k=>[k,data.item[k]]))});
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
      .sort((a,b)=>C.time(b.modifiedTime)-C.time(a.modifiedTime) || b.id.localeCompare(a.id))[0];
  }
  function latestKind(files,id,kind) {
    return files.filter(f=>f.appProperties.folioType===kind && f.appProperties.folioPaperId===id)
      .sort((a,b)=>C.time(b.modifiedTime)-C.time(a.modifiedTime) || b.id.localeCompare(a.id))[0];
  }
  async function sourceFor(pid,files) {
    const local=await S.source(pid);if(local?.blob)return local;
    const file=latestKind(files || await list(),pid,'source');
    if(!file)throw new Error('云端还没有这篇论文的原始 PDF，请在有原稿的设备同步一次。');
    if(Number(file.size)>128*1024*1024 || !/^[\w-]+$/.test(file.id))throw new Error('云端 PDF 无效或过大。');
    const blob=await (await request(API+'/'+file.id+'?alt=media')).blob();
    if(blob.size>128*1024*1024)throw new Error('云端 PDF 超过 128 MB。');
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==pid)throw new Error('云端 PDF 校验失败，请保留文件并重新同步。');
    const source={blob,name:file.name,bound_account:account.permissionId};await S.source(pid,source);return source;
  }
  async function indexes(files) {
    if(!S.saveIndex)return [];
    const ids=[...new Set(files.filter(f=>f.appProperties.folioType==='index').map(f=>f.appProperties.folioPaperId))];
    const cached=await S.indexes();
    for(const id of ids) {
      const file=latestKind(files,id,'index'),prior=cached.find(x=>x.paper_id===id && x.bound_account===account.permissionId);
      const data=prior?.cloud_file_id===file.id ? prior:C.normalize(await download(file));
      if(data.paper_id!==id)throw new Error('云端知识索引标识不匹配。');
      data.cloud_file_id=file.id;data.bound_account=account.permissionId;
      // 阅读进度与批注使用事件日志合并，不依赖索引上传顺序。
      data.reader=C.materialize([data.reader],await opsFor(files,id));await S.saveIndex(data);
    }
    return (await S.indexes()).filter(d=>d.bound_account===account.permissionId);
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
    data.bound_account=account.permissionId;data.pending=[];data.synced_once=true;data.cloud_file_id=file.id;data.cloud_content_hash=await contentHash(data);
    return data;
  }
  async function syncPaper(data,files,deviceId) {
    if(data.bound_account && data.bound_account!==account.permissionId) throw new Error('这篇论文已绑定其他 Google 账号，请切回原账号后同步。');
    let remoteFile=latest(files,data.paper_id);
    const parent=await folder(files);
    const source=S.source && await S.source(data.paper_id);
    if(source?.blob && !latestKind(files,data.paper_id,'source')) {
      if(source.bound_account && source.bound_account!==account.permissionId)throw new Error('原始 PDF 属于另一 Google 账号。');
      const saved=await uploadSource(source,data.paper_id,parent);files.push(saved);
      await S.source(data.paper_id,{...source,bound_account:account.permissionId});
    }
    const bundle=C.normalize(data),hash=await contentHash(bundle);
    if(!remoteFile || data.content_dirty || (data.cloud_content_hash && hash!==data.cloud_content_hash)) {
      // 并发内容修改不覆盖另一端：本机修订通过批注事件继续同步。
      if(remoteFile && data.cloud_content_hash && remoteFile.appProperties.folioContent && remoteFile.appProperties.folioContent!==data.cloud_content_hash && data.paper.meta.text_status==='original') {
        throw new Error('另一端已更新正文，请先下载最新版后再修改正文。原稿和批注仍然保留。');
      }
      remoteFile=await upload((bundle.paper.meta.short_zh || bundle.paper.meta.title_zh || bundle.paper.meta.title_en || '论文').slice(0,60)+'.folio.json',bundle,{folioType:'paper',folioPaperId:data.paper_id,folioContent:hash},parent);
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
    const fresh=await list(), remoteBundle=await getPaper(latest(fresh,data.paper_id),fresh);
    const reader=C.materialize([data.reader,remoteBundle.reader],await opsFor(fresh,data.paper_id));
    const index={...C.normalize({...remoteBundle,reader}),images:{}};
    index.reader.progress={block:null,ratio:0,at:''};
    const indexHash=await hashValue(index),priorIndex=latestKind(fresh,data.paper_id,'index');
    if(!priorIndex || priorIndex.appProperties.folioContent!==indexHash) {
      const file=await upload((index.paper.meta.title_zh || index.paper.meta.title_en || '论文').slice(0,60)+'.knowledge.json',index,{folioType:'index',folioPaperId:data.paper_id,folioContent:indexHash},parent);fresh.push(file);
    }
    const sent=new Set(outgoing.map(op=>op.event_id));
    return S.mergeRemote(data.paper_id,reader,sent,{bound_account:account.permissionId,cloud_file_id:remoteFile.id,cloud_content_hash:await contentHash(remoteBundle),content_dirty:false,
      paper:remoteBundle.paper,images:remoteBundle.images,discussion:remoteBundle.discussion,item:remoteBundle.item,
      expected_content:C.canonical({paper:data.paper,images:data.images,discussion:data.discussion,item:data.item})});
  }
  const drive={login,loadIdentity,list,getPaper,latest,indexes,sourceFor,
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
        const fresh=await list();await indexes(fresh);
        await S.setting('lastSync',new Date().toISOString());return fresh;
      } finally {syncing=false;}
    }
  };
  root.FolioDrive=drive;
})(window);
