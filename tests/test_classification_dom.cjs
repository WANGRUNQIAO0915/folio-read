// DOM-level UI regression with mocked backend; not a rendered-browser test.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require(process.env.JSDOM || 'jsdom');
const root=path.resolve(__dirname,'../easyread/web'), dom=new JSDOM(fs.readFileSync(path.join(root,'library.html'),'utf8'),{url:'http://127.0.0.1:8766/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window, d=w.document;w.matchMedia=()=>({matches:false});w.HTMLElement.prototype.scrollIntoView=()=>{};
let org={schema:1,folders:{f1:{id:'f1',name:'已有文件夹',deleted:false,version:{at:'',id:''}}},assignments:{p001:{folder_id:'f1',tags:['原标签'],version:{at:'',id:''}}}}, saves=0,sends=0,cancels=0,mode='success',sendResolve;
const base={id:'p001',organization_id:'p001',title_en:'Synthetic paper',tags:['原标签'],folder_id:'f1',status:'unread',notes:0,highlights:0,open_questions:0,discussions:0,abstract:'Synthetic abstract'};
function snapshot(){return {...base,...org.assignments.p001};}
let lastImport,lastPreview;
w.fetch=async(url,options={})=>{
 const route=String(url).split('?')[0],body=typeof options.body==='string'?JSON.parse(options.body||'{}'):{};
 let data={};let ok=true;
 if(route==='/api/library')data={items:[snapshot()],organization:org,token:'test',engine:'none',engine_label:'不翻译',first_run:false};
 else if(route==='/api/engines')data={ready:true,found:{}};
 else if(route==='/api/prefs')data={library:{cats:[],hidden:[],pinned:[]}};
 else if(route==='/api/import'){lastImport=String(url);data={id:'p001',new:false};}
 else if(route==='/api/organization/assign'){saves++;for(const a of body.assignments){if('expected_version' in a)assert.deepEqual(a.expected_version,org.assignments[a.paper_id].version);org.assignments[a.paper_id]={folder_id:a.folder_name||a.folder_path?'f2':a.folder_id,tags:a.tags || org.assignments[a.paper_id].tags,version:{at:'2026-01-01T00:00:00Z',id:String(saves)}};if(a.folder_name||a.folder_path)org.folders.f2={id:'f2',name:a.folder_name||a.folder_path.at(-1),deleted:false,version:{at:'',id:''}};}data=org;}
 else if(route==='/api/classification/preview'){lastPreview=body;data={id:'test-preview',provider:'Synthetic',endpoint:'https://example.invalid/v1/chat/completions',model:'test',allow_new_folders:body.allow_new_folders,papers:[{paper_id:'p001'}],folders:[],messages:[{role:'user',content:'Synthetic paper\nEXACT DISCLOSED TEXT'}]};}
 else if(route==='/api/classification/cancel'){cancels++;data={state:'cancelled'};}
 else if(route==='/api/classification/send'){sends++;if(mode==='pending')await new Promise(r=>sendResolve=r);if(mode==='fail'){ok=false;data={error:'模拟失败'};}else data={suggestions:[{paper_id:'p001',folder_id:null,folder_name:'模型建议',tags:['建议标签'],reason:'测试'}]};}
 return {ok,status:ok?200:400,json:async()=>JSON.parse(JSON.stringify(data))};
};
for(const rel of ['js/common/util.js','js/common/journal-rank.js','js/common/organization.js','js/common/classification-editor.js','js/common/confirm.js','js/library/app.js','js/library/sidebar.js','js/library/detail.js','js/library/organization.js','js/library/import.js'])w.eval(fs.readFileSync(path.join(root,rel),'utf8'));
w.PR.useServerUi=()=>{};
const tick=()=>new Promise(r=>setTimeout(r,10));
const click=s=>{assert(d.querySelector(s),'missing '+s);d.querySelector(s).click();};
const change=(s,value)=>{const el=d.querySelector(s);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));};
const open=(auto=false)=>w.PR.lib.openOrganization(['p001'],{auto});
(async()=>{try{
 await tick();await w.PR.lib.load();assert.equal(d.querySelectorAll('#list .row').length,1);
 open();d.querySelector('[data-org-tags]').value='未保存';click('[data-org-close]');assert.equal(saves,0);
 open();d.querySelector('[data-org-tags]').value='A, B, A';click('#orgSave');await tick();assert.equal(saves,1);assert.deepEqual(org.assignments.p001.tags,['A','B']);
 // Opening automatically sends once and places defaults in placeholders, without saving.
 open(true);await tick();assert.equal(sends,1);assert.equal(lastPreview.allow_new_folders,true);assert.equal(saves,1);
 assert.equal(d.querySelector('[data-org-folder]').value,'');assert.equal(d.querySelector('[data-org-folder]').placeholder,'模型建议');assert.equal(d.querySelector('[data-org-tags]').placeholder,'建议标签');
 click('#orgSave');await tick();assert.equal(saves,2);assert.deepEqual(org.assignments.p001.tags,['建议标签']);
 // Edits while a request is pending win; duplicate requests coalesce.
 mode='pending';open(true);await tick();d.querySelector('[data-org-tags]').value='人工复核';click('#orgAI');assert.equal(sends,2);sendResolve();await tick();assert.equal(d.querySelector('[data-org-tags]').value,'人工复核');click('#orgSave');await tick();assert.deepEqual(org.assignments.p001.tags,['人工复核']);
 mode='fail';open(true);await tick();assert.match(d.querySelector('#orgError').textContent,/模拟失败/);assert.equal(d.querySelector('#orgSave').disabled,false);click('[data-org-close]');
 // Cancel suppresses late responses and applies nothing.
 mode='pending';open(true);await tick();const prior=saves;click('[data-org-close]');sendResolve();await tick();assert(!d.querySelector('#organizationDlg.open'));assert.equal(saves,prior);assert(cancels>=1);
 mode='success';open();click('[data-org-clear="tags"]');click('[data-org-clear="folder"]');click('#orgSave');await tick();assert.deepEqual(org.assignments.p001.tags,[]);assert.equal(org.assignments.p001.folder_id,null);
 org.assignments.p001.tags=['legacy, compound'];await w.PR.lib.load();open();d.querySelector('[data-org-folder]').value='已有文件夹';click('#orgSave');await tick();assert.deepEqual(org.assignments.p001.tags,['legacy, compound']);assert.equal(org.assignments.p001.folder_id,'f1');
 // Tree retains ancestry and counts descendants; collapse persists.
 org.folders.child={id:'child',name:'子主题',parent_id:'f1',version:{at:'',id:''},deleted:false};org.assignments.p001.folder_id='child';await w.PR.lib.load();
 assert.equal(d.querySelector('[data-folder="f1"] .n').textContent,'1');assert(d.querySelector('[data-folder="child"]'));click('[data-folder-toggle="f1"]');assert(!d.querySelector('[data-folder="child"]'));click('[data-folder="f1"]');assert.equal(d.querySelectorAll('#list .row').length,1);click('[data-folder-toggle="f1"]');assert(d.querySelector('[data-folder="child"]'));
 // Dragging a paper changes folder only, preserving newly synced tags.
 org.assignments.p001.tags=['并发同步标签'];const drop=new w.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{getData:()=> 'p001'}});d.querySelector('[data-folder="f1"]').dispatchEvent(drop);await tick();assert.deepEqual(org.assignments.p001.tags,['并发同步标签']);
 click('#batchSelect');change('[data-batch]',true);assert.equal(w.PR.lib.batch.size,1);w.PR.lib.render();assert.equal(d.querySelector('[data-batch]').checked,true);w.PR.ls.set('folio-classification-auto',false);click('#organizeBtn');assert.equal(d.querySelectorAll('[data-org-index]').length,1);click('[data-org-close]');
 w.PR.lib.folder='f1';w.PR.openImport();assert.equal(d.querySelector('#importFolder').value,'f1');change('#importFolder','f2');const input=d.querySelector('#fileInput');Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['%PDF-synthetic'],'paper.pdf',{type:'application/pdf'})]});input.dispatchEvent(new w.Event('change'));await tick();assert.match(lastImport,/folder_id=f2/);
 console.log('Desktop DOM: nested folders, subtree counts/filter/collapse, automatic suggestions, placeholders, overrides, error/cancel and legacy preservation passed');
}finally{dom.window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
