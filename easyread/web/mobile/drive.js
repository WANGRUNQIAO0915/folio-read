/* Google Identity Services. Per-file sync remains the default; folder scanning requires an explicit read grant. Tokens stay in memory. */
(function (root) {
  'use strict';
  const C=root.FolioMobile, S=root.FolioStorage,O=root.FolioOrganization;
  const API='https://www.googleapis.com/drive/v3/files';
  const SCOPE='https://www.googleapis.com/auth/drive.file';
  const FOLDER_READ_SCOPE='https://www.googleapis.com/auth/drive.readonly',MAX_SOURCE=128*1024*1024;
  let token='',expires=0,account=null,syncing=false,identity=null,signingIn=false,folderReadGranted=false,lastImportReport=null;
  const hasFolderRead=scopes=>(Array.isArray(scopes)?scopes:typeof scopes==='string'?scopes.split(/\s+/):[]).includes(FOLDER_READ_SCOPE);
  const nativeAuthorization=()=>typeof root.FolioPlatform?.authorizeDrive==='function';
  async function invalidateToken() {
    const rejected=token;token='';expires=0;account=null;folderReadGranted=false;
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
  async function login(clientId,options={}) {
    if(signingIn)throw new Error('Google 授权正在进行，请先完成或关闭当前窗口。');
    if(syncing)throw new Error('云盘同步正在进行，请完成后再切换账号。');
    signingIn=true;lastImportReport=null;
    try {return await authorizeLogin(clientId,options.folderImport===true);} finally {signingIn=false;}
  }
  async function authorizeLogin(clientId,folderImport) {
    // Android uses Google's native authorization UI, never OAuth inside WebView.
    if(nativeAuthorization()) {
      token='';expires=0;account=null;folderReadGranted=false;
      try {
        const authorization=await root.FolioPlatform.authorizeDrive({folderImport});
        const accessToken=typeof authorization==='string'?authorization:authorization?.token;
        if(typeof accessToken!=='string' || !accessToken || /\s/.test(accessToken))throw new Error('Google 授权未返回有效登录凭据。');
        // Native tokens can be cached by Play services; HTTP 401 still invalidates them.
        token=accessToken;expires=Date.now()+50*60*1000;
        // Only a native authorization response may attest granted scopes; never a saved setting.
        folderReadGranted=typeof authorization==='object' && hasFolderRead(authorization?.grantedScopes);
        if(folderImport && (!folderReadGranted || !authorization.grantedScopes.includes(SCOPE)))throw new Error('Google 未授予自动导入所需的只读权限；应用内同步仍可用，请重新连接。');
        account=(await (await request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)')).json()).user;
        if(!account || !account.permissionId)throw new Error('未能确认云盘账号。');
        return account;
      } catch(error) {token='';expires=0;account=null;folderReadGranted=false;throw error;}
    }
    if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId || '')) throw new Error('请先配置 Google 登录客户端 ID。');
    await loadIdentity();
    return new Promise((resolve,reject)=>{
      const client=root.google.accounts.oauth2.initTokenClient({client_id:clientId,scope:folderImport?SCOPE+' '+FOLDER_READ_SCOPE:SCOPE,include_granted_scopes:false,
        callback:async data=>{
          if(data.error || !data.access_token) return reject(new Error('Google 授权未完成。'));
          if(!root.google.accounts.oauth2.hasGrantedAllScopes(data,SCOPE)) return reject(new Error('请允许访问 Folio Read 创建的云盘文件。'));
          if(folderImport && (!hasFolderRead(data.scope) || !root.google.accounts.oauth2.hasGrantedAllScopes(data,SCOPE,FOLDER_READ_SCOPE)))return reject(new Error('请允许 Google Drive 只读权限以启用自动导入。'));
          folderReadGranted=hasFolderRead(data.scope);
          token=data.access_token;expires=Date.now()+Math.max(0,(Number(data.expires_in)||3600)-60)*1000;
          try {
            account=(await (await request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)')).json()).user;
            if(!account || !account.permissionId) throw new Error('未能确认云盘账号。');
            resolve(account);
          } catch(error) {token='';expires=0;account=null;folderReadGranted=false;reject(error);}
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
  const articleContentHash=data=>hashValue({paper:data.paper,images:data.images,discussion:data.discussion,
    item:Object.fromEntries(['status','starred','rating','meta_override'].filter(k=>Object.hasOwn(data.item || {},k)).map(k=>[k,data.item[k]]))});
  // Names have independent immutable snapshots; their edits must never upload an article body.
  const contentHash=articleContentHash;
  const legacyContentHash=data=>hashValue({paper:data.paper,images:data.images,discussion:data.discussion,
    item:Object.fromEntries(['tags','status','starred','rating','meta_override'].filter(k=>Object.hasOwn(data.item || {},k)).map(k=>[k,data.item[k]]))});
  async function folder(files) {
    const existing=files.filter(f=>f.appProperties.folioType==='folder').sort((a,b)=>a.id.localeCompare(b.id))[0];
    if(existing) return existing.id;
    const result=await (await request(API+'?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Folio Read',mimeType:'application/vnd.google-apps.folder',appProperties:{folioApp:'mobile-v1',folioType:'folder'}})})).json();
    files.push({id:result.id,appProperties:{folioType:'folder'}});return result.id;
  }
  async function sourceFolder(files,parent) {
    const existing=files.filter(f=>f.appProperties?.folioType==='source-folder' && f.appProperties?.folioParentId===parent).sort((a,b)=>a.id.localeCompare(b.id))[0];
    if(existing)return existing.id;
    const properties={folioApp:'mobile-v1',folioType:'source-folder',folioParentId:parent};
    const result=await (await request(API+'?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Folio Read Sources',mimeType:'application/vnd.google-apps.folder',parents:[parent],appProperties:properties})})).json();
    files.push({id:result.id,appProperties:properties});return result.id;
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
  const fileRevision=file=>[file.md5Checksum || '',file.sha256Checksum || '',file.modifiedTime || '',file.version || '',String(file.size || '')].join(':');
  const cacheableRevision=file=>!!(file.md5Checksum || file.sha256Checksum || file.modifiedTime || file.version);
  async function folderPdfs(parent) {
    if(!/^[\w-]+$/.test(parent))throw new Error('云盘文件夹标识无效。');
    const files=[];let page='';
    do {
      const params=new URLSearchParams({q:"trashed = false and '"+parent+"' in parents and mimeType != 'application/vnd.google-apps.folder'",pageSize:'1000',fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum,version,appProperties)'});
      if(page)params.set('pageToken',page);
      const result=await (await request(API+'?'+params)).json();
      if(result.incompleteSearch)throw new Error('云盘文件夹扫描不完整，请重试。');
      files.push(...(result.files || []).filter(f=>(f.mimeType==='application/pdf' || /\.pdf$/i.test(f.name || '')) && !(f.appProperties?.folioApp==='mobile-v1' && f.appProperties?.folioType==='source')));
      page=result.nextPageToken || '';
    } while(page);
    return files;
  }
  async function folderPdfBytes(file) {
    if(!/^[\w-]+$/.test(file.id) || !Number.isFinite(Number(file.size)) || Number(file.size)<=0 || Number(file.size)>MAX_SOURCE)throw new Error('PDF 无效或超过 128 MB。');
    const response=await request(API+'/'+file.id+'?alt=media');
    if(Number(response.headers.get('Content-Length'))>MAX_SOURCE)throw new Error('PDF 超过 128 MB。');
    const blob=await response.blob();
    if(blob.size>MAX_SOURCE || blob.size!==Number(file.size))throw new Error('PDF 大小发生变化或超过 128 MB，请下次同步重试。');
    const bytes=new Uint8Array(await blob.arrayBuffer());
    if(!new TextDecoder().decode(bytes.slice(0,1024)).includes('%PDF-'))throw new Error('文件不是有效 PDF。');
    const pid=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(file.sha256Checksum && file.sha256Checksum.toLowerCase()!==pid)throw new Error('PDF 校验失败，请下次同步重试。');
    // Do not cache a revision that changed while its contents were downloading.
    const current=await (await request(API+'/'+file.id+'?fields=id,size,modifiedTime,md5Checksum,sha256Checksum,version')).json();
    if(fileRevision(current)!==fileRevision(file))throw new Error('PDF 在下载期间有更新，请下次同步重试。');
    return {blob,pid};
  }
  function checkAccount(data) {
    if(data?.bound_account && data.bound_account!==account.permissionId)throw new Error('这篇论文已绑定其他 Google 账号，请切回原账号后同步。');
  }
  async function existingPaper(pid,files) {
    let data=await S.get(pid);checkAccount(data);
    if(!data) {
      const remote=latest(files,pid);
      if(remote) {data=await getPaper(remote,files);data=await S.importBundle(data,{preserveExisting:true});checkAccount(data);}
    }
    return data;
  }
  async function importFolderPdfs(files) {
    const report={status:'disabled',scanned:0,imported:0,duplicates:0,cached:0,errors:[]};
    lastImportReport=report;
    if(await S.setting('driveFolderImportEnabled')!==true)return report;
    if(!folderReadGranted) {report.status='permission_required';return report;}
    report.status='complete';
    if(!files.some(f=>f.appProperties?.folioType==='folder'))await folder(files);
    const parents=[...new Set(files.filter(f=>f.appProperties?.folioType==='folder').map(f=>f.id))].sort();
    const seen=new Set();
    for(const parent of parents) {
      const key='drive-folder-cache:'+account.permissionId+':'+parent;
      const prior=await S.setting(key),cache=new Map(Object.entries(prior && typeof prior==='object'?prior:{}));
      let candidates;
      try {candidates=await folderPdfs(parent);} catch(error) {report.errors.push({id:parent,name:'Folio Read',message:error.message});continue;}
      for(const file of candidates) {
        if(seen.has(file.id))continue;seen.add(file.id);report.scanned++;
        try {
          const revision=fileRevision(file),entry=cache.get(file.id);
          if(cacheableRevision(file) && entry?.revision===revision && /^[a-f0-9]{64}$/.test(entry.paper_id || '')) {
            const data=await existingPaper(entry.paper_id,files),source=await S.source(entry.paper_id);checkAccount(source);
            if(data && (source?.blob || latestKind(files,entry.paper_id,'source'))) {report.cached++;continue;}
          }
          const {blob,pid}=await folderPdfBytes(file);
          let data=await existingPaper(pid,files),source=await S.source(pid);checkAccount(source);
          const duplicate=!!data;
          if(!data) {
            if(!root.FolioPDF?.parse)throw new Error('PDF 解析组件尚未就绪，请重试。');
            data=C.normalize(await root.FolioPDF.parse({name:file.name || '论文.pdf',size:blob.size,type:'application/pdf',arrayBuffer:()=>blob.arrayBuffer()}));
            if(data.paper_id!==pid)throw new Error('解析后的 PDF 标识不匹配。');
            if(new TextEncoder().encode(JSON.stringify(data)).length>C.MAX_BYTES)throw new Error('阅读副本超过 64 MB，请拆分 PDF。');
            data.bound_account=account.permissionId;data.pending=[];
          }
          // Keep the external original untouched. Normal sync uploads one app-owned
          // source copy per hash so drive.file-only devices can still read the PDF.
          if(!source?.blob)await S.source(pid,{blob,name:file.name || '论文.pdf',bound_account:account.permissionId,drive_imported:true});
          if(!duplicate) {data=await S.importBundle(data,{preserveExisting:true});checkAccount(data);}
          if(duplicate)report.duplicates++;else report.imported++;
          if(cacheableRevision(file))cache.set(file.id,{revision,paper_id:pid});
          // Persist after each successful file; interrupted scans resume without re-parsing.
          await S.setting(key,Object.fromEntries(cache));
        } catch(error) {report.errors.push({id:file.id,name:file.name || '论文.pdf',message:error.message});}
      }
    }
    if(report.errors.length)report.status='partial';
    return report;
  }
  async function indexes(files) {
    if(!S.saveIndex)return [];
    const ids=[...new Set(files.filter(f=>f.appProperties.folioType==='index').map(f=>f.appProperties.folioPaperId))];
    const cached=await S.indexes();
    for(const id of ids) {
      const file=latestKind(files,id,'index'),prior=cached.find(x=>x.paper_id===id && x.bound_account===account.permissionId);
      const data=prior?.cloud_file_id===file.id ? prior:C.normalize(await download(file));
      if(data.paper_id!==id)throw new Error('云端知识索引标识不匹配。');
      const naming=C.preferNaming(data.item?.naming,await namesFor(id,files));if(naming)data.item={...data.item,naming};
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
  async function namesFor(id,files) {
    let naming=null;
    const key='drive-naming-cache:'+account.permissionId,cache=await S.setting(key)||{};
    for(const file of files.filter(f=>f.appProperties?.folioType==='naming' && f.appProperties.folioPaperId===id)){
      let value=cache[file.id];
      if(!value){value=await download(file);if(value?.schema!==1 || value.kind!=='folio-naming' || value.paper_id!==id || !C.cleanNaming(value.naming))throw new Error('云盘名称记录格式无效，请保留文件并重试。');cache[file.id]=value;}
      naming=C.preferNaming(naming,value.naming);
    }
    await S.setting(key,cache);return naming;
  }
  async function syncNaming(data,files,parent){
    const remote=await namesFor(data.paper_id,files),naming=C.preferNaming(data.item?.naming,remote);
    if(naming && C.canonical(naming)!==C.canonical(remote)){
      const value={schema:1,kind:'folio-naming',paper_id:data.paper_id,naming};
      const file=await upload('名称-'+data.paper_id+'.json',value,{folioType:'naming',folioPaperId:data.paper_id,folioContent:await hashValue(value)},parent);files.push(file);
    }
    return naming;
  }
  async function getPaper(file,files) {
    const data=C.normalize(await download(file));
    if(data.paper_id!==file.appProperties.folioPaperId) throw new Error('云盘论文标识不匹配。');
    const naming=C.preferNaming(data.item?.naming,await namesFor(data.paper_id,files));if(naming)data.item={...data.item,naming};
    if(data.organization&&S.mergeOrganization)await S.mergeOrganization(data.organization);
    data.reader=C.materialize([data.reader],await opsFor(files,data.paper_id));
    data.bound_account=account.permissionId;data.pending=[];data.synced_once=true;data.cloud_file_id=file.id;data.cloud_content_hash=await contentHash(data);data.cloud_article_content_hash=await articleContentHash(data);
    return data;
  }
  async function syncPaper(data,files,deviceId) {
    if(data.bound_account && data.bound_account!==account.permissionId) throw new Error('这篇论文已绑定其他 Google 账号，请切回原账号后同步。');
    let remoteFile=latest(files,data.paper_id);
    const parent=await folder(files);
    const source=S.source && await S.source(data.paper_id);
    if(source?.blob && !latestKind(files,data.paper_id,'source')) {
      if(source.bound_account && source.bound_account!==account.permissionId)throw new Error('原始 PDF 属于另一 Google 账号。');
      const sourceParent=source.drive_imported?await sourceFolder(files,parent):parent;
      const saved=await uploadSource(source,data.paper_id,sourceParent);files.push(saved);
      await S.source(data.paper_id,{...source,bound_account:account.permissionId});
    }
    await syncNaming(data,files,parent);
    const local=C.normalize(data),localArticle=await articleContentHash(local);
    const expectedContent=C.canonical({paper:data.paper,images:data.images,discussion:data.discussion,item:data.item});
    let bundle=local,uploadContent=!remoteFile;
    if(remoteFile){
      const current=await getPaper(remoteFile,files),remoteArticle=await articleContentHash(current);
      let baseline=data.cloud_article_content_hash;
      if(data.cloud_content_hash && [await contentHash(local),localArticle,await legacyContentHash(local)].includes(data.cloud_content_hash))baseline=localArticle;
      if(!baseline && data.cloud_content_hash){
        if(data.cloud_content_hash===localArticle || data.cloud_content_hash===await legacyContentHash(local))baseline=localArticle;
        else {
          const previous=files.find(f=>f.appProperties?.folioType==='paper' && f.appProperties.folioPaperId===data.paper_id && f.appProperties.folioContent===data.cloud_content_hash);
          if(previous)baseline=await articleContentHash(C.normalize(await download(previous)));
        }
      }
      // Naming never gives permission to overwrite a newer translation. Compare the
      // article independently, including for devices upgrading from pre-naming hashes.
      const localChanged=baseline?localArticle!==baseline:!!data.content_dirty || localArticle!==remoteArticle;
      const remoteChanged=baseline?remoteArticle!==baseline:localArticle!==remoteArticle;
      if(localArticle!==remoteArticle && localChanged && remoteChanged)throw new Error('两端正文均有更新或缺少同步基线，请先保留备份并下载最新版。名称、原稿和批注仍保留。');
      if(!localChanged)bundle=current;
      const naming=C.preferNaming(local.item?.naming,current.item?.naming);
      if(naming)bundle={...bundle,item:{...bundle.item,naming}};
      uploadContent=await contentHash(bundle)!==await contentHash(current);
    }
    const hash=await contentHash(bundle);
    if(uploadContent) {
      remoteFile=await upload(C.displayTitle(bundle).slice(0,60)+'.folio.json',bundle,{folioType:'paper',folioPaperId:data.paper_id,folioContent:hash},parent);
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
    delete index.organization;delete index.item.tags;delete index.item.naming;
    index.reader.progress={block:null,ratio:0,at:''};
    const indexHash=await hashValue(index),priorIndex=latestKind(fresh,data.paper_id,'index');
    if(!priorIndex || priorIndex.appProperties.folioContent!==indexHash) {
      const file=await upload(C.displayTitle(index).slice(0,60)+'.knowledge.json',index,{folioType:'index',folioPaperId:data.paper_id,folioContent:indexHash},parent);fresh.push(file);
    }
    const sent=new Set(outgoing.map(op=>op.event_id));
    return S.mergeRemote(data.paper_id,reader,sent,{bound_account:account.permissionId,cloud_file_id:remoteFile.id,cloud_content_hash:await contentHash(remoteBundle),cloud_article_content_hash:await articleContentHash(remoteBundle),content_dirty:false,naming_dirty:false,
      paper:remoteBundle.paper,images:remoteBundle.images,discussion:remoteBundle.discussion,item:remoteBundle.item,
      expected_content:expectedContent});
  }
  async function syncOrganization(files) {
    if(!O || !S.organization || !S.mergeOrganization)return;
    const bound=await S.setting('organization_bound_account');
    if(bound && bound!==account.permissionId)throw new Error('文献分类已绑定其他 Google 账号，请切回原账号后同步。');
    // Never transmit organization belonging to a different account, even on the first organization sync.
    const papers=await S.all();
    if(papers.some(p=>!p.demo&&p.bound_account&&p.bound_account!==account.permissionId))throw new Error('文献分类包含其他 Google 账号的论文，请切回原账号后同步。');
    const eligible=new Set(papers.filter(p=>!p.demo).map(p=>p.paper_id));
    for(const f of files)if(f.appProperties?.folioType==='paper')eligible.add(f.appProperties.folioPaperId);
    let remote=O.empty();
    const cacheKey='drive-organization-cache:'+account.permissionId,cache=await S.setting(cacheKey)||{};
    async function collect(list){for(const f of list.filter(f=>f.appProperties?.folioType==='organization')){
      let data=cache[f.id];if(!data){const raw=await download(f);if(raw.schema!==1|| (raw.kind&&raw.kind!=='folio-organization'))throw new Error('云盘分类文件格式无效，请保留文件并重试。');data=O.normalize(raw.organization||raw);cache[f.id]=data;}
      remote=O.merge(remote,data);
    }}
    await collect(files);
    const merged=await S.mergeOrganization(remote),outgoing=O.subset(merged,[...eligible]);
    outgoing.assignments=Object.fromEntries(Object.entries(outgoing.assignments).filter(([,a])=>a.folder_id||a.tags.length||a.version.at||a.version.id));
    const hash=await hashValue(outgoing);
    if((Object.keys(outgoing.folders).length||Object.keys(outgoing.assignments).length)&&!files.some(f=>f.appProperties?.folioType==='organization'&&f.appProperties.folioContent===hash)){
      // Bind before uploading; ambiguous network completion may already have created a snapshot.
      await S.setting('organization_bound_account',account.permissionId);
      const file=await upload('organization-'+crypto.randomUUID()+'.json',{schema:1,kind:'folio-organization',organization:outgoing},{folioType:'organization',folioContent:hash},await folder(files));files.push(file);cache[file.id]=outgoing;
    }
    if(Object.keys(remote.folders).length||Object.keys(remote.assignments).length)await S.setting('organization_bound_account',account.permissionId);
    const fresh=await list();await collect(fresh);await S.mergeOrganization(remote);await S.setting(cacheKey,cache);
  }
  const drive={login,loadIdentity,list,getPaper,latest,indexes,sourceFor,
    get connected(){return !!token && Date.now()<expires;},get account(){return account;},get syncing(){return syncing;},
    get folderReadGranted(){return !!token && Date.now()<expires && folderReadGranted;},
    get lastImportReport(){return lastImportReport?JSON.parse(JSON.stringify(lastImportReport)):null;},
    logout(){token='';expires=0;account=null;folderReadGranted=false;lastImportReport=null;},
    async syncAll(onProgress) {
      if(syncing) throw new Error('同步正在进行，请稍等。');
      syncing=true;
      try {
        await S.setting('lastSyncAttempt',new Date().toISOString());
        let id=await S.setting('deviceId');if(!id) {id=crypto.randomUUID();await S.setting('deviceId',id);}
        const files=await list();
        if(O&&S.organization){const bound=await S.setting('organization_bound_account');if(bound&&bound!==account.permissionId)throw new Error('文献分类已绑定其他 Google 账号，请切回原账号后同步。');}
        await importFolderPdfs(files);
        const data=await S.all(),errors=[];
        for(let i=0;i<data.length;i++) {
          if(data[i].demo) continue;
          if(onProgress) onProgress(i+1,data.length);
          try {await syncPaper(data[i],files,id);} catch(error) {errors.push(error);}
        }
        const organizationFiles=await list();await syncOrganization(organizationFiles);
        const fresh=await list();await indexes(fresh);
        if(errors.length)throw new Error(errors[0].message+(errors.length>1?'（'+errors.length+' 篇尚未完成同步）':''));
        if(!['partial','permission_required'].includes(lastImportReport?.status))await S.setting('lastSync',new Date().toISOString());
        return fresh;
      } finally {syncing=false;}
    }
  };
  root.FolioDrive=drive;
})(window);
