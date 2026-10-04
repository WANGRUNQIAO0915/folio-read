'use strict';
// Naming runs locally. Every model and Drive request below is a deterministic mock.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const C=require('../easyread/web/mobile/core.js'),O=require('../easyread/web/js/common/organization.js');
const read=name=>fs.readFileSync('easyread/web/mobile/'+name+'.js','utf8');
const clone=value=>value===undefined?undefined:structuredClone(value);
const makePaper=(id='p1',meta={})=>C.normalize({paper_id:id,paper:{meta:{title_en:'Forests and Climate',source:'original.pdf',...meta},blocks:[{id:'intro',type:'para',page:1,en:'First-page title\nPrivate body evidence'},{id:'later',type:'para',page:2,en:'Never send later pages'}]},reader:{...C.emptyReader(),paper_note:{body:'Never send my private notes'}},item:{tags:['keep'],status:'reading'},images:{}});
function coreTests(){
  const p=makePaper(),snapshot=JSON.stringify(p),naming=C.makeNaming(p,' 森林与气候.pdf ','ai_translation','v1','2026-10-04T08:00:00Z');
  assert.equal(naming.title,'森林与气候');assert.equal(naming.original_title,'Forests and Climate');assert.equal(naming.original_filename,'original.pdf');
  assert.equal(JSON.stringify(p),snapshot,'Preparing names must not mutate paper metadata');
  const named=C.normalize({...p,item:{...p.item,naming:{...naming,api_key:'strip-me'}}});
  assert.equal(C.displayTitle(named),'森林与气候');assert(!JSON.stringify(named).includes('strip-me'));
  assert.deepEqual(named.paper,p.paper);assert.deepEqual(named.reader,p.reader);assert.equal(named.paper_id,p.paper_id);
  assert.deepEqual(C.parseImport(JSON.stringify(named)).item.naming,naming,'Backup round trip preserves reviewed names');
  for(const change of [{version:1},{version:''},{source:'invented confidence'},{title:''},{title:'字'.repeat(201)},{updated:'tomorrow'},{updated:'2026-02-30T09:00:00Z'},{updated:'2026-10-04T24:00:00Z'},{updated:'2026-10-04T09:00:00.0001Z'},{version:'bad\ud800'},{original_title:'bad\ud800'},{original_title:[]},{original_filename:'a'.repeat(1001)}])assert.equal(C.cleanNaming({...naming,...change}),null);
  assert.equal(C.normalize({...p,item:{naming:{secret:'drop'}}}).item.naming,undefined);
  assert.equal(C.namingCandidate(makePaper('zh',{title_zh:'已有中文标题'})).source,'existing_chinese');
  assert.equal(C.namingCandidate(makePaper('pdf',{title_en:'中文元数据'})).source,'pdf_metadata');
  assert.equal(C.namingCandidate(p).title,'');assert.equal(C.namingTitle('A\u200b\u202e B.pdf.pdf'),'A B');
  assert.equal(C.preferNaming({...naming,version:'a'},{...naming,version:'z'}).version,'z');
  assert.equal(C.pdfFilename('../CON.pdf'), '_CON.pdf');
  assert.equal(C.pdfFilename('LPT¹.txt.pdf'),'_LPT¹.txt.pdf');
  assert.equal(C.pdfFilename('CON   .txt'),'_CON .txt.pdf');assert.equal(C.pdfFilename('CONIN$'),'_CONIN$.pdf');
  assert.equal(C.pdfFilename('标题/目录\\文档:*?<>|\u202e.pdf.pdf'),'标题_目录_文档_______.pdf');
  assert.equal(C.pdfFilename('..'),'论文.pdf');assert.equal(C.pdfFilename('论文.PDF.'),'论文.pdf');assert.equal(C.pdfFilename('论文.pdf... '),'论文.pdf');assert.equal(C.pdfFilename('e\u0301.pdf'),'é.pdf');
  const long=C.pdfFilename('字'.repeat(1000),'id-2');assert(Buffer.byteLength(long)<=180);assert(long.endsWith(' (id-2).pdf'));
  const rows=['abcdef123456a','abcdef123456b','unique'].map(id=>makePaper(id,{title_zh:id==='unique'?'重复 (abcdef123456)':'重复'})),files=C.pdfFilenames(rows);
  assert.equal(new Set(Object.values(files).map(x=>x.toLowerCase())).size,3);assert.deepEqual(C.pdfFilenames(rows.slice().reverse()),files);
  assert.equal(C.pdfFilenames([makePaper('a',{title_zh:'Résumé'}),makePaper('b',{title_zh:'RÉSUMÉ'})]).a,'Résumé (a).pdf');
}
async function storageTests(){
  const maps={papers:new Map(),settings:new Map(),sources:new Map(),indexes:new Map()};let paperTransactions=0;
  const db={transaction(name,mode){if(name==='papers'&&mode==='readwrite')paperTransactions++;const tx={abort(){},objectStore(){return {get:k=>req(()=>maps[name].get(k)),getAll:()=>req(()=>[...maps[name].values()]),put:(v,k)=>req(()=>{maps[name].set(k||v.paper_id,clone(v));return k||v.paper_id;})};}};let pending=0;function req(fn){pending++;const r={};queueMicrotask(()=>{r.result=clone(fn());r.onsuccess?.();if(!--pending)setTimeout(()=>tx.oncomplete?.(),0);});return r;}return tx;}};
  const indexedDB={open(){const r={};queueMicrotask(()=>{r.result=db;r.onsuccess();});return r;}};
  const window={FolioMobile:C,FolioOrganization:O};vm.runInNewContext(read('storage'),{window,indexedDB,crypto,Promise});const S=window.FolioStorage;
  const p1=makePaper(),p2=makePaper('p2');await S.save(p1);await S.save(p2);const source={name:'original.pdf',blob:new Blob(['%PDF-original-bytes'])};await S.source('p1',source);
  const before=paperTransactions;
  await assert.rejects(S.applyNaming([{paper_id:'p1',title:'正确',source:'manual',expected_version:''},{paper_id:'p2',title:'',source:'manual',expected_version:''}]),/1–200/);
  assert.equal(paperTransactions,before+1,'One transaction validates the batch');assert.equal((await S.get('p1')).item.naming,undefined);
  const result=await S.applyNaming([{paper_id:'p1',title:'同名',source:'manual',expected_version:''},{paper_id:'p2',title:'同名',source:'existing_chinese',expected_version:''}]);
  assert.equal(paperTransactions,before+2,'One atomic transaction for a batch');assert.notEqual(result[0].item.naming.version,result[1].item.naming.version);
  await assert.rejects(S.applyNaming([{paper_id:'p1',title:'Stale',source:'manual',expected_version:''}]),/已在其他/);
  const old=await S.get('p1');assert.deepEqual(old.paper,p1.paper);assert.deepEqual(old.reader,p1.reader);assert.deepEqual(await S.source('p1'),{paper_id:'p1',...source});
  const imported=await S.importBundle(p1);assert.equal(imported.item.naming.title,'同名','Older backup cannot erase reviewed name');
  await S.mergeRemote('p1',p1.reader,new Set(),{item:{tags:['keep']},naming_dirty:false});assert.equal((await S.get('p1')).item.naming.title,'同名');assert.equal((await S.get('p1')).naming_dirty,true);
  const future=await S.get('p2');future.item.naming.updated='2099-01-01T00:00:00Z';await S.save(future);
  const newer=await S.applyNaming([{paper_id:'p2',title:'用户现在确认的名称',source:'manual',expected_version:future.item.naming.version}]);assert(C.time(newer[0].item.naming.updated)>C.time(future.item.naming.updated),'New review wins despite a future-dated imported name');
  const expected=C.canonical({paper:old.paper,images:old.images,discussion:old.discussion,item:old.item});
  await S.applyNaming([{paper_id:'p1',title:'上传时的新名称',source:'manual',expected_version:old.item.naming.version}]);
  await S.mergeRemote('p1',p1.reader,new Set(),{item:old.item,expected_content:expected,naming_dirty:false});assert.equal((await S.get('p1')).item.naming.title,'上传时的新名称');
}
async function aiTests(){
  let requests=0,lastBody,response={suggestions:[{paper_id:'p1',title:'森林与气候'}]},resolveFetch;
  const window={FolioMobile:C};const context={window,URL,Set,fetch:async(url,options)=>{requests++;lastBody=JSON.parse(options.body);assert.equal(url,'https://model.example/chat/completions');assert.equal(options.redirect,'error');return new Promise(resolve=>{resolveFetch=()=>resolve(Response.json({choices:[{message:{content:JSON.stringify(response)}}]}));});}};
  vm.runInNewContext(read('ai'),context);const A=window.FolioAI;A.setConfig({base_url:'https://model.example',model:'test-model',api_key:'device-only-secret'});
  const p=makePaper(),preview=A.namingPreview([p]);assert.equal(requests,0);assert.equal(preview.provider,'model.example');assert.equal(preview.model,'test-model');assert(Object.isFrozen(preview.messages[1]));
  assert.equal(JSON.parse(preview.messages[1].content).papers[0].title,p.paper.meta.title_en);assert(!JSON.stringify(preview).includes('Private body'));assert(!JSON.stringify(preview).includes('private notes'));assert(!JSON.stringify(preview).includes('secret'));
  const fallback=A.namingPreview([makePaper('p1',{title_en:'original'})]);const transmitted=JSON.parse(fallback.messages[1].content).papers[0];assert(transmitted.first_page_excerpt.includes('First-page title'));assert(!transmitted.first_page_excerpt.includes('later pages'));assert.equal(transmitted.title,undefined);
  const bounded=makePaper('p1',{title_en:'original'});bounded.paper.blocks[0].en='字'.repeat(2000);assert.equal([...JSON.parse(A.namingPreview([bounded]).messages[1].content).papers[0].first_page_excerpt].length,1200);
  assert.throws(()=>A.namingPreview([{...p,paper:{meta:{source:'scan.pdf'},blocks:[]}}]),/手动命名/);
  await assert.rejects(A.namePapers(preview),/明确同意/);assert.equal(requests,0);
  const controller=new AbortController();controller.abort();await assert.rejects(A.namePapers(preview,{consent:true,signal:controller.signal}),/取消/);assert.equal(requests,0);
  const request=A.namePapers(preview,{consent:true});await assert.rejects(A.namePapers(preview,{consent:true}),/预览无效/);resolveFetch();const suggestions=await request;assert.equal(suggestions[0].source,'ai_translation');assert.equal(p.item.naming,undefined,'AI does not apply changes');assert(!JSON.stringify(lastBody).includes('notes'));
  const stale=A.namingPreview([p]);A.setConfig({model:'changed'});await assert.rejects(A.namePapers(stale,{consent:true}),/配置已变化/);A.setConfig({model:'test-model'});
  response={suggestions:[{paper_id:'unknown',title:'中文'}]};const bad=A.namePapers(A.namingPreview([p]),{consent:true});resolveFetch();await assert.rejects(bad,/标识/);
  const cancelled=new AbortController(),pending=A.namePapers(A.namingPreview([p]),{consent:true,signal:cancelled.signal});cancelled.abort();resolveFetch();await assert.rejects(pending,/取消/);
}

async function uiTests(){
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const C=require('../easyread/web/mobile/core.js'),O=require('../easyread/web/js/common/organization.js');
const elements=new Map(),listeners={},checkInputs=[];
function element(id){if(elements.has(id))return elements.get(id);const e={id,value:'',checked:false,disabled:false,hidden:false,open:false,dataset:{},events:{},textContent:'',classList:{toggle(){}},setAttribute(){},getAttribute(){},addEventListener(n,fn){this.events[n]=fn;},showModal(){this.open=true;},close(){this.open=false;this.events.close?.();},click(){return this.onclick?.({target:this});},querySelector(){return null;},querySelectorAll(){return [];},focus(){},remove(){},append(){}};Object.defineProperty(e,'innerHTML',{get(){return this._html||'';},set(html){this._html=html;parse(html);}});elements.set(id,e);return e;}
function parse(html){for(const m of html.matchAll(/<(input|select|button|p|section|div|textarea|h\d|details|label)\b([^>]*)>/g)){const attrs=m[2],id=attrs.match(/\bid="([^"]+)"/)?.[1];if(!id)continue;const e=element(id);e.value=attrs.match(/\bvalue="([^"]*)"/)?.[1]||'';e.checked=/\bchecked\b/.test(attrs);e.disabled=/\bdisabled\b/.test(attrs);e.hidden=/\bhidden\b/.test(attrs);if(m[1]==='select'){const rest=html.slice(m.index+m[0].length).split('</select>')[0];const options=[...rest.matchAll(/<option\b([^>]*)>/g)];e.value=(options.find(o=>/\bselected\b/.test(o[1]))||options[0])?.[1].match(/\bvalue="([^"]*)"/)?.[1]||'';}}
if(html.includes('name="namingPaper"')){checkInputs.length=0;for(const m of html.matchAll(/<input\b([^>]*)name="namingPaper"([^>]*)>/g)){const attrs=m[1]+m[2];checkInputs.push({value:attrs.match(/\bvalue="([^"]*)"/)[1],checked:/\bchecked\b/.test(attrs)});}}}
for(const id of ['app','sheet','sheetBody','sheetTitle','sheetClose','toast','tabs','headerStatus','importButton','importFile','selectionTools','selectionNote','selectionCancel','home','themeMeta'])element(id);
const document={querySelector:s=>s==='meta[name="theme-color"]'?element('themeMeta'):elements.get(s.slice(1))||null,querySelectorAll:s=>s==='[name="namingPaper"]:checked'?checkInputs.filter(e=>e.checked):[],addEventListener:(n,fn)=>{listeners[n]=fn;},documentElement:{dataset:{},style:{setProperty(){}}},body:{classList:{toggle(){}},append(){}},hidden:false};
const papers=new Map(),prefs=new Map([['aiOptions',{base_url:'https://model.example',model:'test-model',remember_key:true}],['aiKey','device-only']]);
const fixture=C.normalize({paper_id:'p1',paper:{meta:{title_en:'Forests',authors:'A'},blocks:[{id:'intro',type:'para',en:'forest evidence'}]},reader:C.emptyReader(),item:{tags:[]}});papers.set('p1',fixture);
let delaySave=false,releaseSave=null;
let org=O.seed(O.empty(),[fixture]),mutations=0,requests=0,resolveFetch=null;
const S={indexes:async()=>[],all:async()=>[...papers.values()],get:async id=>papers.get(id),organization:async()=>org,changeOrganization:async fn=>{if(delaySave)await new Promise(resolve=>{releaseSave=resolve;});const next=fn(org);org=next;mutations++;return org;},setting:async(k,v)=>v===undefined?prefs.get(k):prefs.set(k,v),save:async p=>papers.set(p.paper_id,p),update:async(id,fn)=>{const p=papers.get(id);fn(p);return p;},source:async()=>null,importBundle:async p=>{if(!papers.has(p.paper_id))papers.set(p.paper_id,p);return papers.get(p.paper_id);}};
const D={connected:false,syncing:false,lastImportReport:null,account:null};
const window={FolioMobile:C,FolioOrganization:O,FolioStorage:S,FolioDrive:D,FolioPlatform:{native:true,bundledAssets:true},FolioPDF:{MAX_SOURCE:128*1024*1024,sha:async()=> 'p1',parse:async()=>{throw new Error('Duplicate PDF must not parse');}},FolioJournal:{badges:()=>'',visible:()=>false},scrollTo(){},addEventListener(){}};
const context={window,document,crypto,URL,Set,Map,Promise,AbortController,TextEncoder,Blob,Date,console,navigator:{onLine:false},matchMedia:()=>({matches:false,addEventListener(){}}),getSelection:()=>({removeAllRanges(){},isCollapsed:true}),setTimeout:()=>0,clearTimeout(){},setInterval(){},requestAnimationFrame(){},PR:{md:x=>x,citationReferences:[],refById:{}},fetch:async(url,options)=>{if(url==='./config.json')return Response.json({});requests++;return new Promise(resolve=>{resolveFetch=()=>resolve(Response.json({choices:[{message:{content:JSON.stringify({suggestions:[{paper_id:'p1',title:'森林与气候'}]})}}]}));});}};
vm.runInNewContext(fs.readFileSync('easyread/web/mobile/ai.js','utf8'),context);vm.runInNewContext(fs.readFileSync('easyread/web/mobile/app.js','utf8'),context);
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
async function action(dataset,selector='[data-act]'){await listeners.click({target:{closest:s=>s===selector?{dataset}:null},preventDefault(){}});await flush();}
const click=async id=>{await element(id).onclick({target:element(id)});await flush();};
async function preview(){await action({act:'classifyPapers'});await click('previewClassification');}

await flush();assert(element('app').innerHTML.includes('批量中文命名'));
const original=JSON.stringify(fixture.paper);let nameWrites=0;
S.applyNaming=async changes=>{nameWrites++;for(const change of changes){const p=papers.get(change.paper_id);assert.equal(C.cleanNaming(p.item.naming)?.version||'',change.expected_version);p.item.naming=C.makeNaming(p,change.title,change.source,crypto.randomUUID());}return changes.map(c=>papers.get(c.paper_id));};
const start=()=>action({namePaper:'p1'},'[data-name-paper]');
await start();assert.equal(element('namingTitle0').value,'');assert.equal(requests,0);await click('previewNamingAI');assert.equal(requests,0);assert(element('sheetBody').innerHTML.includes('https://model.example/chat/completions'));assert(element('sheetBody').innerHTML.includes('Forests'));assert(!element('sheetBody').innerHTML.includes('forest evidence'));assert.equal(element('requestNaming').disabled,true);assert.equal(element('namingConsent').checked,false);
await click('requestNaming');assert.equal(requests,0);
element('namingConsent').checked=true;const cancelled=element('requestNaming').onclick();await flush();await element('requestNaming').onclick();assert.equal(requests,1);
window.FolioPlatform.onBack();resolveFetch();await cancelled;await flush();assert.equal(element('sheet').open,false);assert.equal(nameWrites,0);assert.equal(papers.get('p1').item.naming,undefined,'Cancelled late AI reply cannot save or reopen');
await start();await click('previewNamingAI');element('namingConsent').checked=true;const pending=element('requestNaming').onclick();await flush();resolveFetch();await pending;await flush();assert.equal(element('namingTitle0').value,'森林与气候');assert(element('sheetBody').innerHTML.includes('非官方'));assert.equal(nameWrites,0,'Suggestion review never auto-applies');
element('namingTitle0').value='我确认的中文标题';const saving=element('applyNaming').onclick(),again=element('applyNaming').onclick();await saving;await again;await flush();assert.equal(nameWrites,1);assert.equal(papers.get('p1').item.naming.source,'manual');assert.equal(papers.get('p1').item.naming.title,'我确认的中文标题');assert.equal(JSON.stringify(fixture.paper),original);
// Selection works for batch editing without making a model request.
papers.set('p2',makePaper('p2',{title_zh:'已有中文标题'}));await action({act:'namePapers'});await click('reviewNamingSelection');element('namingTitle0').value='同名';element('namingTitle1').value='同名';await click('applyNaming');assert.equal(nameWrites,2);assert.equal(papers.get('p2').item.naming.title,'同名');
const exported=[];D.sourceFor=async()=>({name:'DO-NOT-RENAME.pdf',blob:new Blob(['%PDF-verbatim'])});window.FolioPlatform.saveBlob=async(blob,name)=>{exported.push({name,body:await blob.text()});return true;};
await action({exportPaper:'p1'},'[data-export-paper]');await action({exportPaper:'p2'},'[data-export-paper]');assert.equal(exported.length,2);assert.equal(exported[0].body,'%PDF-verbatim');assert.equal(new Set(exported.map(e=>e.name)).size,2);assert(exported.every(e=>e.name.startsWith('同名 (')));
// Initial IndexedDB lookup cannot steal a newer dialog.
const normalAll=S.all;let resolveAll;S.all=()=>new Promise(resolve=>{resolveAll=()=>resolve([...papers.values()]);});const waiting=start();await flush();window.FolioPlatform.onBack();await action({act:'manageFolders'});resolveAll();await waiting;await flush();assert.equal(element('sheetTitle').textContent,'管理文献文件夹');S.all=normalAll;
// Returning from disclosure during a request prevents the old reply changing fields.
await start();element('namingTitle0').value='';await click('previewNamingAI');element('namingConsent').checked=true;const backRequest=element('requestNaming').onclick();await flush();await click('backNaming');element('namingTitle0').value='返回后手动编辑';resolveFetch();await backRequest;await flush();assert.equal(element('namingTitle0').value,'返回后手动编辑');assert.equal(nameWrites,2);
}

async function driveTests(){
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const C=require('../easyread/web/mobile/core.js');
let files=[],folderCount=0,uploads=0,failMedia=false,fail401=false,loginAccount='acct';
const papers=new Map(),prefs=new Map(),sources=new Map(),indexes=new Map();
const S={all:async()=>[...papers.values()],setting:async(k,v)=>v===undefined?prefs.get(k):prefs.set(k,v),mergeRemote:async(id,r,sent,meta)=>{
  const p=papers.get(id);p.reader=r;p.pending=p.pending.filter(o=>!sent.has(o.event_id));Object.assign(p,meta,{synced_once:true});return p;
},source:async(id,value)=>value===undefined?sources.get(id):sources.set(id,value),indexes:async()=>[...indexes.values()],saveIndex:async data=>indexes.set(data.paper_id,data)};
const contents=new Map(),sessions=new Map();let duringNaming=null;
async function fetchMock(url,options={}){
  assert.notEqual(options.method,'PATCH','No original Drive PDF rename/move request');
  assert.equal(options.headers.Authorization,'Bearer transient-token');
  if(fail401){fail401=false;return new Response('{}',{status:401});}
  const u=new URL(url);
  if(u.pathname.endsWith('/about'))return Response.json({user:{permissionId:loginAccount,emailAddress:'test@example.com'}});
  if(u.pathname.includes('/upload/')){
    if(u.searchParams.get('uploadType')==='resumable'){
      const id='session-'+sessions.size;sessions.set(id,JSON.parse(options.body));return new Response('',{status:200,headers:{Location:'https://www.googleapis.com/upload/drive/v3/files?upload_id='+id}});
    }
    if(u.searchParams.get('upload_id')) {
      const meta=sessions.get(u.searchParams.get('upload_id')),f={id:'f'+(++uploads),...meta,size:options.body.size,modifiedTime:new Date(Date.now()+uploads).toISOString()};files.push(f);contents.set(f.id,options.body);return Response.json(f);
    }
    const text=await options.body.text(),boundary=options.headers['Content-Type'].split('boundary=')[1];
    const parts=text.split('--'+boundary),meta=JSON.parse(parts[1].split('\r\n\r\n')[1].trim()),data=JSON.parse(parts[2].split('\r\n\r\n')[1].trim());
    if(meta.appProperties?.folioType==='naming' && duringNaming){duringNaming();duringNaming=null;}
    const f={id:'f'+(++uploads),...meta,modifiedTime:new Date(Date.now()+uploads).toISOString()};files.push(f);contents.set(f.id,data);return Response.json(f);
  }
  if(options.method==='POST'){
    folderCount++;const meta=JSON.parse(options.body),f={...meta,id:'folder'+folderCount};files.push(f);return Response.json(f);
  }
  if(u.searchParams.get('alt')==='media'){
    if(failMedia)return new Response('{}',{status:500});
    const value=contents.get(u.pathname.split('/').pop());return value instanceof Blob?new Response(value):Response.json(value);
  }
  const mid=Math.ceil(files.length/2),page=u.searchParams.get('pageToken');
  return Response.json(page?{files:files.slice(mid)}:{files:files.slice(0,mid),...(files.length>1?{nextPageToken:'second'}:{})});
}
const window={FolioMobile:C,FolioStorage:S,google:{accounts:{oauth2:{hasGrantedAllScopes:()=>true,initTokenClient:opts=>({requestAccessToken(){queueMicrotask(()=>opts.callback({access_token:'transient-token',expires_in:3600}));}})}}}};
vm.runInNewContext(fs.readFileSync('easyread/web/mobile/drive.js','utf8'),{window,fetch:fetchMock,crypto,URL,URLSearchParams,Blob,TextEncoder,TextDecoder,Date,Set,Promise});
const D=window.FolioDrive;
function paper(id){return {...C.normalize({paper_id:id,paper:{meta:{title_zh:id},blocks:[{id:'intro',type:'para',zh:'测试'}]},reader:C.emptyReader(),images:{}}),pending:[{op:'progress',block:'intro',ratio:.2,at:'2026-10-02T01:00:00Z',event_id:'progress-'+id}]};}

await D.login('web.apps.googleusercontent.com');
const blob=new Blob(['%PDF-original-unchanged']),pid=crypto.createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const local=paper(pid);local.paper.meta.title_en='Original English title';local.paper.meta.source='NEVER-RENAME.pdf';local.paper.meta.text_status='translated';local.paper.blocks[0].zh='Translated body v1';papers.set(local.paper_id,local);
sources.set(local.paper_id,{blob,name:'NEVER-RENAME.pdf'});await D.syncAll();
const snapshots=()=>files.filter(f=>['paper','index','source'].includes(f.appProperties.folioType)).length;
const before=snapshots(),originalSource=files.find(f=>f.appProperties.folioType==='source');
let data=papers.get(pid);data.item.naming=C.makeNaming(data,'第一个中文名','manual','name-1','2026-10-04T08:00:00Z');data.naming_dirty=true;
await D.syncAll();assert.equal(snapshots(),before,'Naming-only sync uploads no article/index/source');assert.equal(files.filter(f=>f.appProperties.folioType==='naming').length,1);
assert.equal(originalSource.name,'NEVER-RENAME.pdf');assert.equal(await contents.get(originalSource.id).text(),await blob.text());
const named=await D.getPaper(D.latest(files,pid),files);assert.equal(named.item.naming.title,'第一个中文名','New device merges independent naming snapshot');assert.equal(named.paper.blocks[0].zh,'Translated body v1');
const namedCount=uploads;await D.syncAll();assert.equal(uploads,namedCount,'Repeated sync is idempotent');
const {spawnSync}=require('node:child_process');
const namingSnapshot=contents.get(files.find(f=>f.appProperties.folioType==='naming').id),python=spawnSync('python',['-c','import json,sys;import hashlib;from easyread.portable import canonical;print(hashlib.sha256(canonical(json.load(sys.stdin)).encode()).hexdigest())'],{input:JSON.stringify(namingSnapshot),encoding:'utf8'});
assert.equal(python.status,0,python.stderr);
assert.equal(files.find(f=>f.appProperties.folioType==='naming').appProperties.folioContent,python.stdout.trim());
// A newer remote translation arrives while the name-only snapshot is uploading.
data=papers.get(pid);data.item.naming=C.makeNaming(data,'第二个中文名','manual','name-2','2026-10-04T09:00:00Z');data.naming_dirty=true;
duringNaming=()=>{const translated=C.normalize(papers.get(pid));translated.paper.blocks[0].zh='Translated body v2 arriving during naming';delete translated.item.naming;const f={id:'remote-translation',name:'remote.folio.json',modifiedTime:'2099-01-01T00:00:00Z',appProperties:{folioType:'paper',folioPaperId:pid}};files.push(f);contents.set(f.id,translated);};
const bodiesBefore=files.filter(f=>f.appProperties.folioType==='paper').length;await D.syncAll();assert.equal(files.filter(f=>f.appProperties.folioType==='paper').length,bodiesBefore+1,'Only the simulated remote translation creates an article snapshot');
assert.equal(papers.get(pid).paper.blocks[0].zh,'Translated body v2 arriving during naming');assert.equal(papers.get(pid).item.naming.title,'第二个中文名');assert.equal(contents.get(D.latest(files,pid).id).paper.blocks[0].zh,'Translated body v2 arriving during naming');
for(const f of files.filter(f=>f.appProperties.folioType==='index'))assert.equal(contents.get(f.id).item.naming,undefined,'Indexes are name-independent');
}


function parityTests(){
  const {spawnSync}=require('node:child_process');
  const titles=['中文.pdf.pdf','a\x85b','a\x1cb','a\u200bb','é','e\u0301','𠀀中文','A\nB'];
  const filenames=['../CON.pdf','CON   .txt','CONIN$','CONOUT$','LPT¹.txt.pdf','论文.PDF.','论文.pdf... ','e\u0301.pdf','字'.repeat(1000),'A/B\\C:*?<>|','a\x85b','a\x1cb','\u202e边界','标题.pdf.pdf','title.pdf\ufeff','title.pdf\x85','title.pdf\x1c'];
  const rows=[['aaaaaaaaaaaa1','X'],['aaaaaaaaaaaa2','X'],['z','X (aaaaaaaaaaaa)'],['q','字'.repeat(100)+'a'],['r','字'.repeat(100)+'a']];
  const invalid=['2026-02-30T09:00:00Z','2026-10-04T24:00:00Z','2026-10-04T09:00:00.0001Z','2026-10-04T09:00:00,1Z'];
  const base=C.makeNaming(makePaper(),'验证','manual','v','2026-10-04T09:00:00Z');
  const records=[base,...invalid.map(updated=>({...base,updated})),{...base,version:'bad\ud800'},{...base,original_title:'bad\ud800'}];
  const payload={titles,filenames,rows,records};
  const python=spawnSync('python',['-c',`import json,sys
from easyread import naming as n
p=json.load(sys.stdin)
print(json.dumps({'titles':[n.title(v) for v in p['titles']], 'filenames':[n.pdf_filename(v) for v in p['filenames']], 'rows':n.pdf_filenames(p['rows']), 'records':[n.clean_naming(v) for v in p['records']]},ensure_ascii=True))`],{input:JSON.stringify(payload),encoding:'utf8'});
  assert.equal(python.status,0,python.stderr);const result=JSON.parse(python.stdout);
  assert.deepEqual(titles.map(C.namingTitle),result.titles,'Desktop/mobile title normalization parity');
  assert.deepEqual(filenames.map(value=>C.pdfFilename(value)),result.filenames,'Desktop/mobile safe filename parity');
  assert.deepEqual(C.pdfFilenames(rows.map(([paper_id,title_zh])=>makePaper(paper_id,{title_zh}))),result.rows,'Whole-library suffix allocation parity');
  assert.deepEqual(records.map(C.cleanNaming),result.records,'Timestamp/surrogate validation parity');
}

(async()=>{coreTests();parityTests();await storageTests();await aiTests();await uiTests();await driveTests();console.log('Mobile naming: safe filenames, portable validation, atomic/stale/clock-skew saves, exact frozen AI consent, cancel/back/repeat, editable single/batch previews, byte-identical original-PDF exports, immutable naming sync and concurrent-translation safety passed.');})().catch(e=>{console.error(e);process.exitCode=1;});
