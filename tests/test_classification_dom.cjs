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
 else if(route==='/api/organization/assign'){saves++;for(const a of body.assignments){if('expected_version' in a)assert.deepEqual(a.expected_version,org.assignments[a.paper_id].version);org.assignments[a.paper_id]={folder_id:a.folder_name?'f2':a.folder_id,tags:a.tags || org.assignments[a.paper_id].tags,version:{at:'2026-01-01T00:00:00Z',id:String(saves)}};if(a.folder_name)org.folders.f2={id:'f2',name:a.folder_name,deleted:false,version:{at:'',id:''}};}data=org;}
 else if(route==='/api/classification/preview'){lastPreview=body;data={id:'test-preview',provider:'Synthetic',endpoint:'https://example.invalid/v1/chat/completions',model:'test',allow_new_folders:body.allow_new_folders,papers:[{paper_id:'p001'}],folders:[],messages:[{role:'user',content:'Synthetic paper\nEXACT DISCLOSED TEXT'}]};}
 else if(route==='/api/classification/cancel'){cancels++;data={state:'cancelled'};}
 else if(route==='/api/classification/send'){sends++;if(mode==='pending')await new Promise(r=>sendResolve=r);if(mode==='fail'){ok=false;data={error:'模拟失败'};}else data={suggestions:[{paper_id:'p001',folder_id:null,folder_name:'模型建议',tags:['建议标签'],reason:'测试'}]};}
 return {ok,status:ok?200:400,json:async()=>JSON.parse(JSON.stringify(data))};
};
for(const rel of ['js/common/util.js','js/common/journal-rank.js','js/common/confirm.js','js/library/app.js','js/library/sidebar.js','js/library/detail.js','js/library/organization.js','js/library/import.js'])w.eval(fs.readFileSync(path.join(root,rel),'utf8'));
w.PR.useServerUi=()=>{};
const tick=()=>new Promise(r=>setTimeout(r,10));
const click=s=>{assert(d.querySelector(s),'missing '+s);d.querySelector(s).click();};
const change=(s,value)=>{const el=d.querySelector(s);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));};
const open=()=>w.PR.lib.openOrganization(['p001']);
async function preview(){click('#orgAI');await tick();assert.equal(d.querySelector('#orgSend').disabled,true);assert.equal(d.querySelector('#orgConsent').checked,false);assert.match(d.querySelector('.org-payload').textContent,/EXACT DISCLOSED TEXT/);}
(async()=>{try{
 await tick();await w.PR.lib.load();assert.equal(d.querySelectorAll('#list .row').length,1);assert.match(d.querySelector('#side').textContent,/文件夹/);
 // Manual changes stay local until Save; cancellation is reversible.
 open();d.querySelector('[data-org-tags]').value='未保存';click('[data-org-close]');assert.equal(saves,0);assert.deepEqual(org.assignments.p001.tags,['原标签']);
 open();d.querySelector('[data-org-tags]').value='A, B, A';click('#orgSave');await tick();assert.equal(saves,1);assert.deepEqual(org.assignments.p001.tags,['A','B']);assert(!d.querySelector('#organizationDlg.open'));
 // Preview never sends; explicit consent required; repeat clicks coalesce.
 open();assert.equal(d.querySelector('#orgAllowNewFolders').checked,false);await preview();assert.equal(lastPreview.allow_new_folders,false);assert.equal(sends,0);click('[data-org-close]');await tick();assert.equal(sends,0);
 open();change('#orgAllowNewFolders',true);await preview();assert.equal(lastPreview.allow_new_folders,true);change('#orgConsent',true);click('#orgSend');click('#orgSend');await tick();assert.equal(sends,1);assert.equal(saves,1);assert.match(d.querySelector('.org-message').textContent,/尚未保存/);assert.equal(d.querySelector('[data-org-folder]').value,'__new__');assert.equal(d.querySelector('[data-org-name]').value,'模型建议');d.querySelector('[data-org-tags]').value='已复核';click('#orgSave');await tick();assert.equal(saves,2);assert.deepEqual(org.assignments.p001.tags,['已复核']);
 // Failed send leaves editor usable and preserves data.
 mode='fail';open();await preview();change('#orgConsent',true);click('#orgSend');await tick();assert.match(d.querySelector('#orgError').textContent,/模拟失败/);assert.equal(saves,2);click('[data-org-close]');await tick();
 // Late response after Cancel must not reopen the editor or apply changes.
 mode='pending';open();await preview();change('#orgConsent',true);click('#orgSend');await tick();click('[data-org-close]');mode='success';sendResolve();await tick();assert(!d.querySelector('#organizationDlg.open'));assert.equal(saves,2);assert(cancels>=3);
 // Batch selection persists through re-render and duplicate open is ignored.
 click('#batchSelect');change('[data-batch]',true);assert.equal(w.PR.lib.batch.size,1);w.PR.lib.render();assert.equal(d.querySelector('[data-batch]').checked,true);click('#organizeBtn');open();assert.equal(d.querySelectorAll('[data-org-index]').length,1);click('[data-org-close]');
 // Drag/drop folder-only moves must preserve newly synced tags rather than cached row tags.
 org.assignments.p001.tags=['并发同步标签'];
 const drop=new w.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{getData:()=> 'p001'}});d.querySelector('[data-folder="f1"]').dispatchEvent(drop);await tick();assert.deepEqual(org.assignments.p001.tags,['并发同步标签']);assert.equal(org.assignments.p001.folder_id,'f1');
 // An unchanged legacy tag containing a comma is preserved when only moving folders.
 org.assignments.p001.tags=['legacy, compound'];await w.PR.lib.load();open();change('[data-org-folder]','f2');click('#orgSave');await tick();assert.deepEqual(org.assignments.p001.tags,['legacy, compound']);
 // Import options surface stable folder IDs; direct current-folder import uses them.
 w.PR.lib.folder='f1';w.PR.openImport();assert.equal(d.querySelector('#importFolder').value,'f1');change('#importFolder','f2');const input=d.querySelector('#fileInput');Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['%PDF-synthetic'],'paper.pdf',{type:'application/pdf'})]});input.dispatchEvent(new w.Event('change'));await tick();assert.match(lastImport,/folder_id=f2/);assert.equal(sends,3); // success, failure, cancelled request only
 assert.equal(d.querySelector('#organizationDlg.open'),null);
 console.log('Desktop DOM regression passed: manual classification, folder import, multi-tags, batch selection, AI preview/consent/review/failure/cancel/repeat.');
}finally{dom.window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
