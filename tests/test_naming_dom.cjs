// Desktop DOM state-machine regressions; mock API only, no model / user library.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require(process.env.JSDOM || 'jsdom');
const root=path.resolve(__dirname,'../easyread/web');
const dom=new JSDOM(fs.readFileSync(path.join(root,'library.html'),'utf8'),{url:'http://127.0.0.1:8766/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;w.matchMedia=()=>({matches:false});w.HTMLElement.prototype.scrollIntoView=()=>{};
const originals=[{id:'p001',title_en:'Original English title',title_zh:'已有中文标题',original_filename:'original-1.pdf'},{id:'p002',title_en:'Second source title <unsafe>',original_filename:'original-2.pdf'}];
const items=originals.map(i=>({...i,display_title:i.title_zh || i.title_en,pdf_filename:i.original_filename,tags:[],status:'unread',notes:0,highlights:0,open_questions:0,discussions:0}));
let mode='',saves=0,sends=0,cancels=0,previews=0,suggests=0,resolvePending,lastRows,previewIds=[];
const clone=x=>JSON.parse(JSON.stringify(x));
const suggestion=i=>({paper_id:i.id,title:i.display_title,source:i.naming?.source || (i.title_zh?'existing_chinese':'bibliographic_metadata'),original_title:i.title_en,original_filename:i.original_filename,expected_version:i.naming?.version || '',pdf_filename:i.pdf_filename});
w.fetch=async(url,options={})=>{
 const route=String(url).split('?')[0],body=typeof options.body==='string'?JSON.parse(options.body||'{}'):{};
 let data={},ok=true;
 if(route==='/api/library')data={items:clone(items),organization:{folders:{},assignments:{}},token:'test',engine:'none',engine_label:'不翻译',first_run:false};
 else if(route==='/api/prefs')data={library:{cats:[],hidden:[],pinned:[]}};
 else if(route==='/api/engines')data={ready:true,found:{}};
 else if(route==='/api/naming/suggest'){
  suggests++;data={suggestions:items.filter(i=>body.paper_ids.includes(i.id)).map(suggestion)};
  if(mode==='suggest-pending')await new Promise(r=>resolvePending=r);
  if(mode==='suggest-fail'){ok=false;data={error:'模拟读取失败'};}
 }
 else if(route==='/api/naming/preview'){
  previews++;previewIds=body.paper_ids;
  data={id:'preview-'+previews,provider:'Test provider',endpoint:'https://naming.example.invalid/v1/chat/completions',model:'test-translator',messages:[{role:'system',content:'Only translate titles'},{role:'user',content:'EXACT DISCLOSED TEXT <not-markup>'}],papers:body.paper_ids};
  if(mode==='preview-pending')await new Promise(r=>resolvePending=r);
  if(mode==='preview-incomplete')delete data.endpoint;
 }
 else if(route==='/api/naming/cancel'){cancels++;data={state:'cancelled'};}
 else if(route==='/api/naming/send'){
  sends++;assert.equal(body.confirmed,true);
  if(mode==='send-pending')await new Promise(r=>resolvePending=r);
  if(mode==='send-fail'){ok=false;data={error:'模拟生成失败'};}
  else data={suggestions:items.filter(i=>previewIds.includes(i.id)).map(i=>({...suggestion(i),title:'AI 中文译名',source:'ai_translation',pdf_filename:'AI 中文译名.pdf'}))};
 }
 else if(route==='/api/naming/apply'){
  if(mode==='apply-fail'){ok=false;data={error:'版本变化，请重新预览'};}
  else{
   saves++;lastRows=clone(body.suggestions);
   for(const row of body.suggestions){
    const i=items.find(i=>i.id===row.paper_id);assert.equal(row.expected_version,i.naming?.version || '');
    assert.deepEqual(Object.keys(row).sort(),['expected_version','paper_id','source','title']);
    Object.assign(i,{display_title:row.title,pdf_filename:row.title+'.pdf',naming:{source:row.source,version:'v'+saves}});
   }
   data={items:clone(items),suggestions:items.map(suggestion)};
   if(mode==='apply-pending')await new Promise(r=>resolvePending=r);
  }
 }
 return {ok,status:ok?200:409,json:async()=>clone(data)};
};
for(const rel of ['js/common/util.js','js/common/journal-rank.js','js/common/organization.js','js/common/classification-editor.js','js/common/confirm.js','js/library/app.js','js/library/sidebar.js','js/library/detail.js','js/library/organization.js','js/library/naming.js'])w.eval(fs.readFileSync(path.join(root,rel),'utf8'));
w.PR.useServerUi=()=>{};
const tick=()=>new Promise(r=>setTimeout(r,15));
const el=s=>{const e=d.querySelector(s);assert(e,'missing '+s);return e;};
const click=s=>el(s).click();
const fill=(s,value)=>{el(s).value=value;el(s).dispatchEvent(new w.Event('input',{bubbles:true}));};
const check=(s,value=true)=>{el(s).checked=value;el(s).dispatchEvent(new w.Event('change',{bubbles:true}));};
const open=async(ids=['p001'])=>{w.PR.lib.openNaming(ids);await tick();};
const close=()=>click('#namingDlg [data-naming-close]');
async function preview(){click('#namingAI');await tick();assert.equal(el('#namingSend').disabled,true);assert.equal(el('#namingConsent').checked,false);assert.match(el('.naming-provider').textContent,/naming.example.invalid\/v1\/chat\/completions/);assert.match(el('.naming-payload').textContent,/EXACT DISCLOSED TEXT <not-markup>/);}
(async()=>{try{
 await tick();await w.PR.lib.load();
 assert.equal(el('#namingBtn').hidden,true);
 // Local suggestions do not call a model, expose originals, and only explicit apply saves.
 w.PR.lib.select('p001');el('[data-name-paper]').focus();click('[data-name-paper]');await tick();
 assert.equal(d.activeElement,el('[data-naming-title]'));assert.equal(sends,0);assert.equal(previews,0);assert.equal(saves,0);
 assert.match(el('.naming-original').textContent,/Original English title/);assert.match(el('.naming-original').textContent,/original-1.pdf/);
 fill('[data-naming-title]','未应用');close();assert.equal(saves,0);assert.equal(d.activeElement,el('[data-name-paper]'));assert.equal(el('#namingDlg').inert,true);
 await open();fill('[data-naming-title]','人工复核中文名');click('#namingSave');click('#namingSave');await tick();
 assert.equal(saves,1);assert.equal(lastRows[0].source,'manual');assert.equal(items[0].title_zh,originals[0].title_zh);assert.equal(items[0].title_en,originals[0].title_en);
 assert.match(el('#list .t1').textContent,/人工复核中文名/);assert.match(el('#list .t2').textContent,/Original English title/);
 assert.match(el('#detail .naming-display').textContent,/人工复核中文名/);assert.equal(el('#detail a[download]').getAttribute('href'),'/api/p/p001/pdf');
 // Blank / overly long input stays local; Unicode astral characters count once each.
 await open();fill('[data-naming-title]','   ');click('#namingSave');await tick();assert.equal(saves,1);assert.match(el('#namingError').textContent,/请填写/);
 fill('[data-naming-title]','字'.repeat(201));click('#namingSave');await tick();assert.equal(saves,1);assert.match(el('#namingError').textContent,/200/);close();
 // Consent is exact, fresh, and cannot be bypassed by clicking a disabled button.
 await open();await preview();click('#namingSend');assert.equal(sends,0);click('#namingBack');await tick();assert.equal(el('[data-naming-title]').value,'人工复核中文名');await preview();close();assert.equal(sends,0);assert.equal(saves,1);
 await open();await preview();check('#namingConsent');click('#namingSend');click('#namingSend');await tick();
 assert.equal(sends,1);assert.equal(saves,1);assert.match(el('.naming-message').textContent,/尚未保存/);assert.match(el('.naming-source').textContent,/非官方译名/);assert.equal(el('[data-naming-title]').value,'AI 中文译名');
 click('#namingSave');await tick();assert.equal(saves,2);assert.equal(items[0].naming.source,'ai_translation');assert.match(el('#detail').textContent,/非官方译名/);
 // AI revisions remain clearly labeled during review, then carry manual provenance when edited.
 await open();fill('[data-naming-title]','人工编辑 AI 译名');assert.match(el('.naming-ai-note').textContent,/非官方译名/);assert.match(el('[data-naming-source]').textContent,/人工命名/);close();
 // Model failure retains local edits; incomplete provider disclosure can never send.
 mode='send-fail';await open();fill('[data-naming-title]','保留草稿');await preview();check('#namingConsent');click('#namingSend');await tick();assert.match(el('#namingError').textContent,/模拟生成失败/);assert.equal(el('[data-naming-title]').value,'保留草稿');assert.equal(saves,2);close();
 mode='preview-incomplete';await open();click('#namingAI');await tick();assert.match(el('#namingError').textContent,/发送信息不完整/);assert.equal(d.querySelector('#namingConsent'),null);close();
 // A cancelled model response must not reopen or overwrite a newer review.
 mode='send-pending';await open();await preview();check('#namingConsent');click('#namingSend');await tick();const finishSend=resolvePending;close();mode='';await open(['p002']);fill('[data-naming-title]','新窗口草稿');finishSend();await tick();assert.equal(el('[data-naming-title]').value,'新窗口草稿');assert.equal(saves,2);close();
 // Cancelled preview and initial suggestion replies are ignored and tokens cancelled.
 mode='preview-pending';await open();click('#namingAI');await tick();const finishPreview=resolvePending;close();mode='';finishPreview();await tick();assert.equal(d.querySelector('#namingDlg.open'),null);
 mode='suggest-pending';w.PR.lib.openNaming(['p001']);await tick();const finishSuggest=resolvePending;close();mode='';finishSuggest();await tick();assert.equal(d.querySelector('#namingDlg.open'),null);
 // Suggest failures are recoverable and cannot apply; old versions are not silently retried.
 mode='suggest-fail';await open();assert.match(el('#namingDlg').textContent,/模拟读取失败/);assert.equal(d.querySelector('#namingSave'),null);mode='';click('#namingRetry');await tick();assert(el('[data-naming-title]'));close();
 mode='apply-fail';await open();fill('[data-naming-title]','冲突草稿');click('#namingSave');await tick();assert.equal(saves,2);assert.match(el('#namingError').textContent,/版本变化/);assert.equal(el('[data-naming-title]').value,'冲突草稿');close();mode='';
 // Batch selection remains usable after re-render. Double open does not replace the draft.
 click('#batchSelect');for(const c of d.querySelectorAll('[data-batch]')){c.checked=true;c.dispatchEvent(new w.Event('change',{bubbles:true}));}
 assert.equal(el('#namingBtn').disabled,false);assert.match(el('#namingBtn').textContent,/2/);w.PR.lib.render();assert.equal(d.querySelectorAll('[data-batch]:checked').length,2);
 click('#namingBtn');await tick();w.PR.lib.openNaming(['p001']);assert.equal(d.querySelectorAll('[data-naming-index]').length,2);assert.match(el('#namingDlg').textContent,/Second source title <unsafe>/);assert.equal(d.querySelector('unsafe'),null);
 const inputs=d.querySelectorAll('[data-naming-title]');inputs[0].value='批量一';inputs[1].value='批量二';click('#namingSave');await tick();assert.equal(saves,3);assert.equal(lastRows.length,2);assert.deepEqual(items.map(i=>i.display_title),['批量一','批量二']);
 // Applying is non-reentrant; dismissal cannot falsely claim it cancelled a committed write.
 mode='apply-pending';await open();fill('[data-naming-title]','应用中');click('#namingSave');await tick();const finishApply=resolvePending;close();assert(el('#namingDlg.open'));assert.equal(el('[data-naming-close]').disabled,true);el('#namingDlg').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(el('#namingDlg.open'));finishApply();await tick();assert.equal(saves,4);assert.equal(d.querySelector('#namingDlg.open'),null);mode='';
 // Escape from editable input cancels without a save and keeps the underlying selection.
 await open();fill('[data-naming-title]','不保存');el('[data-naming-title]').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(d.querySelector('#namingDlg.open'),null);assert.equal(saves,4);assert(cancels>=6);assert(suggests>=15);
 // Large local batches remain available but cannot invoke AI above the explicit 20-paper cap.
 for(let n=3;n<=21;n++)items.push({...items[1],id:'p'+String(n).padStart(3,'0'),naming:undefined});await w.PR.lib.load();
 const beforePreviews=previews;await open(items.map(i=>i.id));assert.equal(d.querySelectorAll('[data-naming-title]').length,21);assert.equal(el('#namingAI').disabled,true);click('#namingAI');await tick();assert.equal(previews,beforePreviews);close();
 console.log('Desktop naming DOM passed: local/batch review, preserved originals, exact consent, AI provenance, errors, stale replies, duplicate clicks, conflict and Escape.');
}finally{dom.window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
