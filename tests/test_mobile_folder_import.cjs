'use strict';
// No Google account or external network: exercise actual Drive orchestration with
// paginated Drive responses and a local parser double. Real binary decoding and
// the native Google consent screen still require integration/device testing.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const C=require('../easyread/web/mobile/core.js');
const FILE_SCOPE='https://www.googleapis.com/auth/drive.file',READ_SCOPE='https://www.googleapis.com/auth/drive.readonly';
const code=fs.readFileSync('easyread/web/mobile/drive.js','utf8');
const clone=value=>value===undefined?undefined:structuredClone(value);
const hash=async blob=>crypto.createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
function bundle(pid,title='original') {
  return {...C.normalize({paper_id:pid,paper:{meta:{source_sha256:pid,title_en:title,text_status:'original'},blocks:[{id:'pdf-p1-t0',type:'para',page:1,en:'Local PDF text',zh:''}]},reader:C.emptyReader(),images:{},item:{tags:[],status:'unread'}}),pending:[]};
}
function harness(options={}) {
  const state={requestedScope:null,scopes:options.scopes??[FILE_SCOPE,READ_SCOPE],account:'account-a',failParse:new Set(),failPaper:new Set(),mutateDuringDownload:null,cacheWriteFailure:false,unauthorized:false};
  const files=[],contents=new Map(),papers=new Map(),sources=new Map(),prefs=new Map(),indexes=new Map(),requests=[],parsed=[],sessions=new Map();
  let serial=0;
  function addFile(meta,value) {
    const id=meta.id || 'file-'+(++serial),file={id,modifiedTime:'2026-10-03T01:00:00Z',version:'1',...meta};
    files.push(file);if(value!==undefined)contents.set(id,value);return file;
  }
  const folder=addFile({id:'folder-a',name:'Folio Read',mimeType:'application/vnd.google-apps.folder',appProperties:{folioApp:'mobile-v1',folioType:'folder'}});
  const S={
    all:async()=>clone([...papers.values()]),get:async id=>clone(papers.get(id)),
    source:async(id,value)=>value===undefined?clone(sources.get(id)):sources.set(id,clone(value)),
    setting:async(key,value)=>{
      if(value===undefined)return clone(prefs.get(key));
      if(key.startsWith('drive-folder-cache:')&&state.cacheWriteFailure)throw new Error('Device storage full');
      prefs.set(key,clone(value));return value;
    },
    importBundle:async(data,settings={})=>{
      if(settings.preserveExisting&&papers.has(data.paper_id))return clone(papers.get(data.paper_id));
      papers.set(data.paper_id,clone(data));return clone(data);
    },
    mergeRemote:async(id,reader,sent,meta)=>{
      const data=papers.get(id);data.reader=clone(reader);data.pending=(data.pending||[]).filter(op=>!sent.has(op.event_id));
      Object.assign(data,clone(meta),{synced_once:true});return clone(data);
    },indexes:async()=>clone([...indexes.values()]),saveIndex:async data=>indexes.set(data.paper_id,clone(data))
  };
  const window={FolioMobile:C,FolioStorage:S,FolioAI:{translate(){throw new Error('Folder import must not call AI');}},FolioPDF:{parse:async file=>{
    const text=await (new Blob([await file.arrayBuffer()])).text();parsed.push(file.name);
    if(state.failParse.has(file.name))throw new Error('PDF requires a password');
    const data=bundle(await hash(new Blob([text])),file.name);if(text.includes('scanned'))data.paper.blocks=[];return data;
  }}};
  if(options.native)window.FolioPlatform={authorizeDrive:async()=>options.legacyNative?'transient-token':{token:'transient-token',grantedScopes:state.scopes},clearDriveToken:async()=>{}};
  else window.google={accounts:{oauth2:{hasGrantedAllScopes:(data,...scopes)=>scopes.every(scope=>data.scope.split(' ').includes(scope)),initTokenClient:settings=>({requestAccessToken(){
    state.requestedScope=settings.scope;assert.equal(settings.include_granted_scopes,false);
    queueMicrotask(()=>settings.callback({access_token:'transient-token',expires_in:3600,scope:state.scopes.join(' ')}));
  }})}}};
  async function fetchMock(url,settings={}) {
    assert.equal(settings.headers.Authorization,'Bearer transient-token');
    requests.push({url,method:settings.method||'GET'});
    if(state.unauthorized)return new Response('{}',{status:401});
    const u=new URL(url);
    if(u.pathname.endsWith('/about'))return Response.json({user:{permissionId:state.account,emailAddress:'test@example.invalid'}});
    if(u.pathname.includes('/upload/')) {
      if(u.searchParams.get('uploadType')==='resumable') {
        const session='upload-'+(++serial);sessions.set(session,JSON.parse(settings.body));
        return new Response('',{headers:{Location:'https://www.googleapis.com/upload/drive/v3/files?upload_id='+session}});
      }
      if(u.searchParams.get('upload_id')) {
        const meta=sessions.get(u.searchParams.get('upload_id'));
        const result=addFile({...meta,size:String(settings.body.size),id:'copy-'+(++serial)},settings.body);return Response.json(result);
      }
      const boundary=settings.headers['Content-Type'].split('boundary=')[1],parts=(await settings.body.text()).split('--'+boundary);
      const meta=JSON.parse(parts[1].split('\r\n\r\n')[1].trim()),data=JSON.parse(parts[2].split('\r\n\r\n')[1].trim());
      if(meta.appProperties.folioType==='paper'&&state.failPaper.has(meta.appProperties.folioPaperId))return new Response('{"error":{"message":"Temporary upload failure"}}',{status:503});
      return Response.json(addFile({...meta,id:'managed-'+(++serial)},data));
    }
    if(settings.method==='POST')return Response.json(addFile(JSON.parse(settings.body)));
    assert.equal(settings.method,undefined,'No original may be patched, moved, renamed, or deleted');
    const id=u.pathname.split('/').pop();
    if(id!=='files') {
      const file=files.find(f=>f.id===id);assert(file,'Requested file must exist');
      if(u.searchParams.get('alt')==='media') {
        const value=contents.get(id);
        if(state.mutateDuringDownload===id){file.version=String(Number(file.version)+1);state.mutateDuringDownload=null;}
        return value instanceof Blob?new Response(value):Response.json(value);
      }
      return Response.json(file);
    }
    const query=u.searchParams.get('q'),parent=query.match(/'([\w-]+)' in parents/);
    const matches=parent?files.filter(f=>f.parents?.includes(parent[1])&&f.mimeType!=='application/vnd.google-apps.folder'):files.filter(f=>f.appProperties?.folioApp==='mobile-v1');
    const offset=Number(u.searchParams.get('pageToken')||0),page=matches.slice(offset,offset+2);
    return Response.json({files:page,...(offset+2<matches.length?{nextPageToken:String(offset+2)}:{})});
  }
  vm.runInNewContext(code,{window,fetch:fetchMock,crypto,URL,URLSearchParams,Blob,TextEncoder,TextDecoder,Date,Set,Map,Promise});
  const addPdf=(name,text,extra={})=>{const blob=new Blob([text],{type:'application/pdf'});return addFile({name,mimeType:'application/pdf',parents:[folder.id],size:String(blob.size),...extra},blob);};
  const originalsDownloaded=()=>requests.filter(r=>r.url.includes('alt=media')&&files.some(f=>!f.appProperties&&r.url.includes('/'+f.id+'?'))).length;
  return {D:window.FolioDrive,S,state,files,contents,papers,sources,prefs,indexes,requests,parsed,folder,addPdf,addFile,originalsDownloaded};
}
async function connect(h,enabled=true){h.prefs.set('driveFolderImportEnabled',enabled);await h.D.login('test.apps.googleusercontent.com');}
(async()=>{
  {
    const h=harness({scopes:[FILE_SCOPE]});await h.D.login('test.apps.googleusercontent.com');assert.equal(h.state.requestedScope,FILE_SCOPE);
    await assert.rejects(h.D.login('test.apps.googleusercontent.com',{folderImport:true}),/只读权限/);assert.equal(h.state.requestedScope,FILE_SCOPE+' '+READ_SCOPE);
    h.state.scopes=[FILE_SCOPE,READ_SCOPE];await h.D.login('test.apps.googleusercontent.com',{folderImport:true});assert.equal(h.D.folderReadGranted,true);
    await h.D.login('test.apps.googleusercontent.com');assert.equal(h.state.requestedScope,FILE_SCOPE,'Default connection stays narrow even after opt-in');
  }
  for(const scopes of [[FILE_SCOPE],[READ_SCOPE]]) {
    const h=harness({native:true,scopes});await assert.rejects(h.D.login('',{folderImport:true}),/只读权限/);assert.equal(h.D.connected,false);assert.equal(h.D.folderReadGranted,false);
  }
  for(const options of [{scopes:[FILE_SCOPE]}, {native:true,legacyNative:true}]) {
    const h=harness(options);h.addPdf('dropped.pdf','%PDF-1.7\nordinary');await connect(h);h.prefs.set('driveFolderReadGranted',true);
    await h.D.syncAll();assert.equal(h.D.folderReadGranted,false);assert.equal(h.D.lastImportReport.status,'permission_required');assert.equal(h.prefs.get('lastSync'),undefined);assert(h.prefs.get('lastSyncAttempt'));
    assert.equal(h.parsed.length,0);assert.equal(h.originalsDownloaded(),0);assert(!h.requests.some(r=>new URL(r.url).searchParams.get('q')?.includes(' in parents')));
  }
  {
    const h=harness();h.addPdf('not-enabled.pdf','%PDF-1.7\nordinary');await connect(h,false);await h.D.syncAll();
    assert.equal(h.D.lastImportReport.status,'disabled');assert(h.prefs.get('lastSync'));assert.equal(h.originalsDownloaded(),0);
  }
  {
    const h=harness({native:true}),first=h.addPdf('first.pdf','%PDF-1.7\nordinary'),duplicate=h.addPdf('RENAMED.PDF','%PDF-1.7\nordinary',{mimeType:'application/octet-stream'});
    const scanned=h.addPdf('scanned.pdf','%PDF-1.7\nscanned document'),bad=h.addPdf('broken.pdf','This is not a PDF');
    h.addPdf('encrypted.pdf','%PDF-1.7\nlocked');h.state.failParse.add('encrypted.pdf');h.addPdf('huge.pdf','%PDF-1.7',{size:String(129*1024*1024)});
    h.addFile({name:'notes.txt',mimeType:'text/plain',parents:[h.folder.id],size:'4'},new Blob(['text']));
    h.addPdf('elsewhere.pdf','%PDF-1.7\nprivate elsewhere',{parents:['unrelated-folder']});
    const originalSnapshot=clone([first,duplicate,scanned,bad]);await connect(h);await h.D.syncAll();
    assert.equal(h.D.folderReadGranted,true);assert.equal(h.D.lastImportReport.status,'partial');
    assert.equal(h.D.lastImportReport.imported,2);assert.equal(h.D.lastImportReport.duplicates,1);assert.equal(h.D.lastImportReport.errors.length,3);assert.equal(h.prefs.get('lastSync'),undefined);assert(h.prefs.get('lastSyncAttempt'));
    assert.equal(h.papers.size,2);assert.equal(h.indexes.size,2);assert.deepEqual([first,duplicate,scanned,bad],originalSnapshot);
    const sourceFolder=h.files.find(f=>f.appProperties?.folioType==='source-folder');assert(sourceFolder);assert.equal(sourceFolder.name,'Folio Read Sources');assert.deepEqual(sourceFolder.parents,[h.folder.id]);
    const managedSources=h.files.filter(f=>f.appProperties?.folioType==='source');assert.equal(managedSources.length,2);assert(managedSources.every(f=>f.parents[0]===sourceFolder.id));
    const pid=await hash(h.contents.get(first.id));assert.equal(h.sources.get(pid).drive_imported,true);assert.equal(await h.contents.get(managedSources.find(f=>f.appProperties.folioPaperId===pid).id).text(),await h.contents.get(first.id).text());
    assert.equal(h.parsed.filter(name=>name!=='encrypted.pdf').length,2);assert(!h.parsed.includes('RENAMED.PDF'));assert(!h.parsed.includes('elsewhere.pdf'));
    const cache=h.prefs.get('drive-folder-cache:account-a:'+h.folder.id);assert.equal(Object.keys(cache).length,3);assert(!cache[bad.id]);
    const downloads=h.originalsDownloaded(),parsed=h.parsed.length;await h.D.syncAll();
    assert.equal(h.D.lastImportReport.cached,3);assert.equal(h.D.lastImportReport.imported,0);assert.equal(h.parsed.length,parsed+1,'A failed encrypted PDF is retried');assert.equal(h.originalsDownloaded(),downloads+2,'Only retry failed downloadable PDFs');
    assert.equal(h.files.filter(f=>f.appProperties?.folioType==='source').length,2);
    // Changing metadata with unchanged bytes rehashes, but never reparses/replaces content.
    first.version='2';first.name='changed-name.pdf';await h.D.syncAll();assert.equal(h.D.lastImportReport.duplicates,1);assert(!h.parsed.includes('changed-name.pdf'));
    // Replace the bytes at the same Drive ID: keep the old paper and import a new hash.
    const changed=new Blob(['%PDF-1.7\nnew edition']);h.contents.set(first.id,changed);first.size=String(changed.size);first.version='3';await h.D.syncAll();assert.equal(h.papers.size,3);assert.equal(h.D.lastImportReport.imported,1);assert(h.papers.has(pid));
    // A removed local reading copy is recovered from the managed remote bundle via cached hash.
    h.papers.delete(pid);const before=h.originalsDownloaded();await h.D.syncAll();assert(h.papers.has(pid));assert.equal(h.originalsDownloaded(),before+2);
    assert(!JSON.stringify([...h.prefs.values()]).includes('transient-token'));
  }
  {
    const h=harness(),source=h.addPdf('translated-already.pdf','%PDF-1.7\ntranslated original'),pid=await hash(h.contents.get(source.id)),translated=bundle(pid,'Preserve translated title');
    translated.paper.meta.text_status='translated';translated.paper.blocks[0].zh='已有译文';translated.item.tags=['keep'];translated.reader.notes.n={id:'n',anchor:'pdf-p1-t0',body:'Keep annotation',updated:'2026-10-03T02:00:00Z'};
    h.addFile({name:'translated.folio.json',appProperties:{folioApp:'mobile-v1',folioType:'paper',folioPaperId:pid}},translated);
    await connect(h);await h.D.syncAll();assert.equal(h.parsed.length,0);assert.equal(h.papers.get(pid).paper.blocks[0].zh,'已有译文');assert.equal(h.papers.get(pid).reader.notes.n.body,'Keep annotation');assert.deepEqual(h.papers.get(pid).item.tags,['keep']);
    // A second device has no cache, downloads only for hashing and reuses the bundle/source.
    h.papers.clear();h.sources.clear();h.prefs.clear();await connect(h);const copies=h.files.filter(f=>f.appProperties?.folioType==='source').length;
    await h.D.syncAll();assert.equal(h.parsed.length,0);assert.equal(h.files.filter(f=>f.appProperties?.folioType==='source').length,copies);assert.equal(h.papers.get(pid).paper.meta.text_status,'translated');
  }
  {
    const h=harness(),file=h.addPdf('changed-mid-download.pdf','%PDF-1.7\nchanges');h.state.mutateDuringDownload=file.id;await connect(h);await h.D.syncAll();
    assert.equal(h.papers.size,0);assert.equal(h.D.lastImportReport.errors.length,1);assert.equal(h.parsed.length,0);assert.equal(h.prefs.get('drive-folder-cache:account-a:'+h.folder.id),undefined);
    await h.D.syncAll();assert.equal(h.papers.size,1);assert.equal(h.parsed.length,1);
  }
  {
    const h=harness(),file=h.addPdf('storage.pdf','%PDF-1.7\nkeep local'),pid=await hash(h.contents.get(file.id));h.state.cacheWriteFailure=true;await connect(h);await h.D.syncAll();
    assert(h.papers.has(pid));assert.equal(h.D.lastImportReport.errors.length,1);assert.equal(h.prefs.get('drive-folder-cache:account-a:'+h.folder.id),undefined);
    h.state.cacheWriteFailure=false;await h.D.syncAll();assert.equal(h.parsed.length,1);assert.equal(h.D.lastImportReport.duplicates,1);
  }
  {
    const h=harness(),first=h.addPdf('first.pdf','%PDF-1.7\nfirst'),second=h.addPdf('second.pdf','%PDF-1.7\nsecond');await connect(h);
    const firstId=await hash(h.contents.get(first.id)),secondId=await hash(h.contents.get(second.id));h.state.failPaper.add(firstId);
    await assert.rejects(h.D.syncAll(),/Temporary upload failure/);assert(h.files.some(f=>f.appProperties?.folioType==='paper'&&f.appProperties.folioPaperId===secondId));
    assert.equal(h.papers.get(firstId).synced_once,undefined);h.state.failPaper.clear();await h.D.syncAll();assert.equal(h.papers.get(firstId).synced_once,true);
  }
  {
    const h=harness(),file=h.addPdf('different-account.pdf','%PDF-1.7\naccount-bound'),pid=await hash(h.contents.get(file.id)),data=bundle(pid);data.bound_account='other-account';h.papers.set(pid,data);await connect(h);
    await assert.rejects(h.D.syncAll(),/其他 Google/);assert.equal(h.D.lastImportReport.errors.length,1);assert.equal(h.parsed.length,0);assert.equal(h.sources.size,0);assert.equal(h.papers.get(pid).bound_account,'other-account');
    h.state.unauthorized=true;await assert.rejects(h.D.list(),/已过期/);assert.equal(h.D.folderReadGranted,false);h.D.logout();assert.equal(h.D.lastImportReport,null);
  }
  console.log('Mobile Drive folder import: opt-in + verified scope gate, pagination, SHA-256 dedup, metadata preservation, per-revision cache/recovery, managed source subfolder, malformed/encrypted/oversized/scanned PDFs, race/retry, partial progress, account isolation, and optional verified broad consent with narrow default passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
