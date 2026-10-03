'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const C=require('../easyread/web/mobile/core.js');
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
const window={FolioMobile:C,FolioStorage:S,google:{accounts:{oauth2:{hasGrantedAllScopes:()=>true,initTokenClient:opts=>({requestAccessToken(){queueMicrotask(()=>opts.callback({access_token:'transient-token',expires_in:3600}));}})}}}};
vm.runInNewContext(fs.readFileSync('easyread/web/mobile/drive.js','utf8'),{window,fetch:fetchMock,crypto,URL,URLSearchParams,Blob,TextEncoder,TextDecoder,Date,Set,Promise});
const D=window.FolioDrive;
function paper(id){return {...C.normalize({paper_id:id,paper:{meta:{title_zh:id},blocks:[{id:'intro',type:'para',zh:'测试'}]},reader:C.emptyReader(),images:{}}),pending:[{op:'progress',block:'intro',ratio:.2,at:'2026-10-02T01:00:00Z',event_id:'progress-'+id}]};}
(async()=>{
  await D.login('web.apps.googleusercontent.com');assert(D.connected);
  papers.set('paper-a',paper('paper-a'));papers.set('paper-b',paper('paper-b'));
  await D.syncAll();assert.equal(folderCount,1);assert.equal(uploads,6);
  assert.equal((await D.list()).length,7);assert.equal(papers.get('paper-a').pending.length,0);
  assert.equal(indexes.size,2,'云端正文索引独立于下载的图片副本');
  assert(!JSON.stringify([...prefs.values()]).includes('transient-token'));
  for(const f of files)assert.equal(f.permissions,undefined);
  const count=uploads;loginAccount='other';await D.login('web.apps.googleusercontent.com');
  await assert.rejects(D.syncAll(),/其他 Google/);assert.equal(uploads,count);
  loginAccount='acct';await D.login('web.apps.googleusercontent.com');
  papers.get('paper-a').pending.push({op:'paper_note',body:'未确认上传不能清空',at:'2026-10-02T02:00:00Z',event_id:'inflight'});
  failMedia=true;await assert.rejects(D.syncAll());assert.equal(papers.get('paper-a').pending.length,1);failMedia=false;
  await D.syncAll();assert.equal(papers.get('paper-a').pending.length,0);
  const pdf=new Blob(['%PDF-1.7\n独立手机上传验证']),pid=crypto.createHash('sha256').update(Buffer.from(await pdf.arrayBuffer())).digest('hex');
  const imported=paper(pid);imported.paper.meta.source_sha256=pid;papers.set(pid,imported);sources.set(pid,{blob:pdf,name:'mobile.pdf'});
  await D.syncAll();assert(files.some(f=>f.appProperties.folioType==='source'&&f.appProperties.folioPaperId===pid));
  assert.equal(indexes.size,3);sources.delete(pid);
  const original=await D.sourceFor(pid,files);assert.equal(await original.blob.text(),await pdf.text(),'另一设备可取回完全相同的原始 PDF');
  assert.equal(sources.get(pid).bound_account,'acct');
  const cloud=await D.getPaper(D.latest(files,pid),files);assert.equal(cloud.paper_id,pid);
  assert(!JSON.stringify(contents.get(D.latest(files,pid).id)).includes('transient-token'));
  fail401=true;await assert.rejects(D.list(),/已过期/);assert.equal(D.connected,false);
  D.logout();assert.equal(D.account,null);
  console.log('Mobile Drive pagination, private folder, account isolation, failed sync, retries, and token lifetime: passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
