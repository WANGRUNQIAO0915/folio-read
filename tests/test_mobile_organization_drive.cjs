'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const C=require('../easyread/web/mobile/core.js'),O=require('../easyread/web/js/common/organization.js');
let files=[],folderCount=0,uploads=0,failMedia=false,fail401=false,loginAccount='acct';
const papers=new Map(),prefs=new Map(),sources=new Map(),indexes=new Map();
const S={all:async()=>[...papers.values()],setting:async(k,v)=>v===undefined?prefs.get(k):prefs.set(k,v),mergeRemote:async(id,r,sent,meta)=>{
  const p=papers.get(id);p.reader=r;p.pending=p.pending.filter(o=>!sent.has(o.event_id));Object.assign(p,meta,{synced_once:true});return p;
},source:async(id,value)=>value===undefined?sources.get(id):sources.set(id,value),indexes:async()=>[...indexes.values()],saveIndex:async data=>indexes.set(data.paper_id,data)};
const contents=new Map(),sessions=new Map();
async function fetchMock(url,options={}){
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
S.organization=async()=>O.seed(prefs.get('organization'),[...papers.values()]);
S.mergeOrganization=async value=>{const merged=O.merge(await S.organization(),value);prefs.set('organization',merged);return merged;};
const window={FolioMobile:C,FolioStorage:S,FolioOrganization:O,google:{accounts:{oauth2:{hasGrantedAllScopes:()=>true,initTokenClient:opts=>({requestAccessToken(){queueMicrotask(()=>opts.callback({access_token:'transient-token',expires_in:3600}));}})}}}};
vm.runInNewContext(fs.readFileSync('easyread/web/mobile/drive.js','utf8'),{window,fetch:fetchMock,crypto,URL,URLSearchParams,Blob,TextEncoder,TextDecoder,Date,Set,Promise});
const D=window.FolioDrive;
function paper(id){return {...C.normalize({paper_id:id,paper:{meta:{title_zh:id},blocks:[{id:'intro',type:'para',zh:'测试'}]},reader:C.emptyReader(),images:{}}),pending:[{op:'progress',block:'intro',ratio:.2,at:'2026-10-02T01:00:00Z',event_id:'progress-'+id}]};}
(async()=>{
  await D.login('web.apps.googleusercontent.com');
  let org=O.createFolder(O.empty(),'Empty folder'),folder=O.live(org)[0].id;prefs.set('organization',org);
  await D.syncAll();assert.equal(files.filter(f=>f.appProperties.folioType==='organization').length,1,'Empty folder syncs without any paper');
  const first=uploads;await D.syncAll();assert.equal(uploads,first,'Repeated sync does not reupload identical organization');
  papers.set('paper-a',paper('paper-a'));papers.get('paper-a').paper.meta.text_status='original';await D.syncAll();
  const uploadedPaper=files.find(f=>f.appProperties.folioType==='paper'),uploadedPayload=structuredClone(contents.get(uploadedPaper.id));
  uploadedPayload.item.tags=['ignored metadata','tag two'];
  const pythonHash=spawnSync('python',['-c','import sys,json;from easyread.drive import Drive;print(Drive.content_hash(json.load(sys.stdin)))'],{input:JSON.stringify(uploadedPayload),encoding:'utf8'});assert.equal(pythonHash.status,0,pythonHash.stderr);assert.equal(uploadedPaper.appProperties.folioContent,pythonHash.stdout.trim(),'Desktop/mobile content hashes agree and classification tags are independent');
  for(const file of files.filter(f=>f.appProperties.folioType==='index')){assert.equal(contents.get(file.id).organization,undefined);assert.equal(contents.get(file.id).item.tags,undefined);}
  const contentCount=files.filter(f=>['paper','index','source'].includes(f.appProperties.folioType)).length;
  papers.get('paper-a').cloud_content_hash='legacy-pre-organization-hash';await D.syncAll();assert.equal(files.filter(f=>['paper','index','source'].includes(f.appProperties.folioType)).length,contentCount,'Old hash format must not cause a false original-text conflict or upload');
  org=O.assign(await S.organization(),[{paper_id:'paper-a',folder_id:folder,tags:['alpha','beta']}]);prefs.set('organization',org);
  await D.syncAll();assert.equal(files.filter(f=>['paper','index','source'].includes(f.appProperties.folioType)).length,contentCount,'Organization edits do not upload paper bodies, indexes, or PDFs');
  const latestOrg=files.filter(f=>f.appProperties.folioType==='organization').at(-1);assert.equal(contents.get(latestOrg.id).kind,'folio-organization');
  const deviceB=O.renameFolder(org,folder,'Renamed elsewhere');
  const remote={id:'remote-b',name:'organization-b.json',modifiedTime:new Date().toISOString(),appProperties:{folioType:'organization',folioContent:'remote-hash'}};files.push(remote);contents.set(remote.id,{schema:1,kind:'folio-organization',organization:deviceB});
  prefs.set('organization',O.deleteFolder(org,folder));await D.syncAll();const merged=await S.organization();assert.equal(merged.folders[folder].deleted,true);assert.equal(O.assignment(merged,'paper-a').folder_id,null);assert.deepEqual(merged.assignments['paper-a'].tags,['alpha','beta']);
  // An upgraded device may retain the old tags-inclusive hash while the desktop has newer translated text.
  const local=papers.get('paper-a');local.paper.meta.text_status='translated';local.paper.blocks[0].zh='Older local translation';local.item.tags=['legacy-tag'];local.content_dirty=false;
  const legacyBody={paper:local.paper,images:local.images,discussion:local.discussion,item:Object.fromEntries(['tags','status','starred','rating','meta_override'].filter(k=>Object.hasOwn(local.item,k)).map(k=>[k,local.item[k]]))};
  local.cloud_content_hash=crypto.createHash('sha256').update(C.canonical(legacyBody)).digest('hex');
  const translated=C.normalize(local);translated.paper.blocks[0].zh='Newer remote translation';translated.item.tags=['remote metadata'];
  const translatedHash=spawnSync('python',['-c','import sys,json;from easyread.drive import Drive;print(Drive.content_hash(json.load(sys.stdin)))'],{input:JSON.stringify(translated),encoding:'utf8'});assert.equal(translatedHash.status,0,translatedHash.stderr);
  const newer={id:'remote-new-translation',name:'new.folio.json',modifiedTime:'2099-01-01T00:00:00Z',appProperties:{folioType:'paper',folioPaperId:'paper-a',folioContent:translatedHash.stdout.trim()}};files.push(newer);contents.set(newer.id,translated);
  const paperSnapshots=files.filter(f=>f.appProperties.folioType==='paper').length;await D.syncAll();assert.equal(files.filter(f=>f.appProperties.folioType==='paper').length,paperSnapshots,'Upgrade must not overwrite newer remote translation with unchanged local text');assert.equal(papers.get('paper-a').paper.blocks[0].zh,'Newer remote translation');
  // Simulate a new device downloading the same snapshot set, without any downloaded paper body.
  papers.clear();prefs.delete('organization');prefs.delete('drive-organization-cache:acct');await D.syncAll();assert.equal((await S.organization()).folders[folder].deleted,true);assert.deepEqual((await S.organization()).assignments['paper-a'].tags,['alpha','beta']);
  loginAccount='other';await D.login('web.apps.googleusercontent.com');const before=uploads;await assert.rejects(D.syncAll(),/其他 Google/);assert.equal(uploads,before,'Account switch never uploads old organization');
  assert(!JSON.stringify([...contents.values()]).includes('transient-token'));
  console.log('Mobile organization Drive: empty-folder sync, immutable snapshots, repeated-sync idempotence, body/PDF independence, deleted-folder convergence, fresh-device metadata, and account isolation passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
