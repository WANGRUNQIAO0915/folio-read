// Real desktop browser + Python API; all external traffic blocked, model mocked.
'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT || 'playwright');
const PYTHON=process.env.PYTHON || 'python', ROOT=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'folio-classification-browser-')), home=path.join(temp,'home'), library=path.join(home,'library');
const artifacts=path.resolve(process.env.BROWSER_ARTIFACTS || path.join(__dirname,'shots','classification'));
fs.mkdirSync(library,{recursive:true});fs.mkdirSync(artifacts,{recursive:true});
const env={};for(const k of ['PATH','SystemRoot','WINDIR','LD_LIBRARY_PATH','VIRTUAL_ENV'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:home,APPDATA:home,EASYREAD_HOME:home,EASYREAD_LIBRARY:library,PYTHONUTF8:'1',PYTHONUNBUFFERED:'1',PYTHONIOENCODING:'utf-8',PYTHONPATH:ROOT});
fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({engine:'none',auto_translate:false,claude:{command:'disabled'},codex:{command:'disabled'},openai:{base_url:'https://classification.example.invalid/v1',model:'mock-classifier',api_key:'',preset:'custom'},chat:{models:[{id:'classify',name:'Mock classification',engine:'openai',model:'mock-classifier',base_url:'https://classification.example.invalid/v1',preset:'custom'}],default:'classify'}}));
const fixture=path.join(temp,'fixture.pdf'), calls=path.join(temp,'calls.jsonl'), guard=path.join(artifacts,'network-guard.jsonl');
const support=path.join(__dirname,'classification_browser_support.py');
const countCalls=()=>fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).length:0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let server,browser,page,url,context;
const errors=[], browserLog=[], layoutSamples=[];
async function wait(check,label){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await delay(80);}throw new Error('Timed out: '+label);}
// Startup library and preference responses can both replace the sidebar. Read
// all dimensions in one page task, rather than holding an element across renders.
async function folderLayout(fid) {
  return page.evaluate(fid=>{
    const row=document.querySelector('[data-folder="'+fid+'"]');
    const box=el=>{
      if(!el)return null;
      const rect=el.getBoundingClientRect(), style=getComputedStyle(el);
      return {connected:el.isConnected,x:rect.x,y:rect.y,width:rect.width,height:rect.height,
        display:style.display,visibility:style.visibility,flex:style.flex,gap:style.gap,
        padding:style.padding,gridTemplateColumns:style.gridTemplateColumns};
    };
    return {at:new Date().toISOString(),readyState:document.readyState,fonts:document.fonts.status,
      viewport:{width:innerWidth,height:innerHeight},bodyClass:document.body.className,
      stylesheets:[...document.querySelectorAll('link[rel="stylesheet"]')].map(link=>({href:link.href,loaded:!!link.sheet})),
      lib:box(document.querySelector('.lib')),sidebar:box(document.querySelector('#side')),
      row:box(row),text:box(row?.querySelector('.t')),menu:box(row?.querySelector('[data-folder-more]')),
      folder:window.PR?.lib?.organization?.folders?.[fid] || null};
  },fid);
}
async function assertFolderLayout(fid,label) {
  let sample, previous;
  await wait(async()=>{
    sample=await folderLayout(fid);layoutSamples.push({label,...sample});
    const ready=sample.readyState==='complete' && sample.fonts==='loaded' && sample.stylesheets.every(s=>s.loaded) &&
      sample.sidebar?.width>0 && sample.row?.width>0 && sample.row?.connected && sample.text?.connected && sample.menu?.connected &&
      sample.text.width>80 && sample.menu.width>0 && sample.menu.width<=24;
    const stable=ready && previous?.text?.width===sample.text.width && previous?.menu?.width===sample.menu.width;
    previous=sample;
    return stable;
  },label+' readable folder layout');
  assert.ok(sample.text.width>80,'folder name retains readable width beside menu button: '+JSON.stringify(sample));
  assert.ok(sample.menu.width<=24,'folder menu stays compact: '+JSON.stringify(sample));
  console.log('Folder layout '+label+': '+JSON.stringify(sample));
}
async function post(route,body){return page.evaluate(async({route,body})=>{const r=await fetch(route,{method:'POST',headers:{'X-Token':PR.token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};},{route,body});}
async function openOne(){await page.locator('#list .row').first().click();await page.locator('#detail [data-organize-paper]').click();await page.locator('#organizationDlg.open').waitFor();}
async function cancel(){await page.locator('#organizationDlg [data-org-close]').first().click();await page.locator('#organizationDlg.open').waitFor({state:'hidden'});}
async function current(){return page.evaluate(()=>PR.lib.items);}
async function prepare(){await page.locator('#orgSave').waitFor({state:'visible'});await wait(()=>page.locator('#orgSave').isEnabled(),'AI recommendation');assert.match(await page.locator('#orgPayload').textContent(),/Folio Offline Regression Fixture/);}
(async()=>{try{
  execFileSync(PYTHON,[support,'fixture',fixture],{cwd:temp,env});
  server=spawn(PYTHON,[support,'serve',guard,calls],{cwd:temp,env,stdio:['ignore','pipe','pipe']});let output='';
  server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>fs.appendFileSync(path.join(artifacts,'server.log'),b));
  await wait(()=>{const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)url=m[0];return !!url;},'server');
  browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  await context.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===url||['data:','blob:'].includes(u.protocol)?r.continue():r.abort('blockedbyclient');});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.stack || e.message));
  page.on('console',m=>browserLog.push(new Date().toISOString()+' console.'+m.type()+': '+m.text()));
  page.on('requestfailed',r=>browserLog.push(new Date().toISOString()+' requestfailed: '+r.url()+' '+JSON.stringify(r.failure())));
  await page.goto(url);await page.waitForFunction(()=>!!PR.token);
  // Folder creation is a UI action and survives a refresh while still empty.
  await page.locator('[data-folder-create]').first().click();await page.locator('.cf-input').fill('手动资料');await page.locator('[data-cf="ok"]').click();
  await page.waitForFunction(()=>Object.values(PR.lib.organization.folders).some(f=>f.name==='手动资料'));
  let state=await page.evaluate(()=>PR.lib.organization);const fid=Object.keys(state.folders)[0];
  for(let reload=1;reload<=3;reload++){
    await page.reload();await page.locator('[data-folder="'+fid+'"]').waitFor();
    await assertFolderLayout(fid,'empty-folder reload '+reload);
  }
  // Import into the chosen logical folder without AI.
  await page.locator('#importBtn').click();await page.locator('#importFolder').selectOption(fid);await page.locator('#fileInput').setInputFiles(fixture);
  await page.locator('#list .row').waitFor();let items=await current(),pid=items[0].id;assert.equal(items[0].folder_id,fid);assert.equal(countCalls(),0);
  const bytes=fs.readFileSync(path.join(library,pid,'source.pdf'));
  // Duplicate PDF remains in its existing folder and only one PDF exists.
  await page.locator('#importBtn').click();await page.locator('#importFolder').selectOption('');await page.locator('#fileInput').setInputFiles(fixture);await page.locator('#importDlg.open').waitFor({state:'hidden'});await page.waitForFunction(()=>PR.lib.items.length===1);assert.equal((await current())[0].folder_id,fid);
  // Manual tags, folder moves, stable rename, and no PDF changes.
  await openOne();await prepare();await page.locator('[data-org-tags]').fill('遥感, 城市');await page.locator('[data-org-folder]').fill('手动资料');await page.locator('#orgSave').click();await page.locator('#organizationDlg.open').waitFor({state:'hidden'});await page.waitForFunction(()=>PR.lib.items[0].tags.includes('城市'));
  assert.deepEqual((await current())[0].tags,['遥感','城市']);assert.deepEqual(fs.readFileSync(path.join(library,pid,'source.pdf')),bytes);
  await page.locator('[data-folder-more="'+fid+'"]').click();await page.getByText('重命名文件夹',{exact:true}).click();await page.locator('.cf-input').fill('热环境资料');await page.locator('[data-cf="ok"]').click();await page.waitForFunction(fid=>PR.lib.organization.folders[fid].name==='热环境资料',fid);assert.equal((await current())[0].folder_id,fid);
  // Automatic suggestions preserve the old assignment until explicitly saved.
  await openOne();await prepare();const count=countCalls();assert.equal(await page.locator('[data-org-tags]').inputValue(),'');assert.equal(await page.locator('[data-org-tags]').getAttribute('placeholder'),'城市热环境, GIS');assert.deepEqual((await current())[0].tags,['遥感','城市']);await cancel();assert.deepEqual((await current())[0].tags,['遥感','城市']);
  await openOne();await prepare();assert.equal(countCalls(),count+1);await page.locator('[data-org-folder]').fill('研究主题 / 绿洲 / 水资源');await page.locator('[data-org-tags]').fill('人工复核, GIS');await page.locator('#orgSave').click();await page.locator('#organizationDlg.open').waitFor({state:'hidden'});await page.waitForFunction(()=>PR.lib.items[0].tags.includes('人工复核'));
  state=await page.evaluate(()=>PR.lib.organization);const root=Object.values(state.folders).find(f=>f.name==='研究主题').id,leaf=(await current())[0].folder_id;
  assert.equal(state.folders[state.folders[leaf].parent_id].name,'绿洲');await assertFolderLayout(root,'parent-with-toggle');await page.locator('[data-folder="'+root+'"] .t').click();assert.equal(await page.locator('#list .row').count(),1);await page.locator('[data-folder-toggle="'+root+'"]').click();assert.equal(await page.locator('[data-folder="'+leaf+'"]').count(),0);await page.reload();await page.locator('[data-folder="'+root+'"]').waitFor();assert.equal(await page.locator('[data-folder="'+leaf+'"]').count(),0);await page.locator('[data-folder-toggle="'+root+'"]').click();await page.locator('[data-folder="'+leaf+'"]').waitFor();
  // Failed automatic requests leave a usable manual editor.
  await context.route('**/api/classification/send',r=>r.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'模拟服务失败'})}));await openOne();await page.getByText(/AI 暂时不可用：模拟服务失败/).waitFor();assert.equal(await page.locator('#orgSave').isEnabled(),true);await cancel();await context.unroute('**/api/classification/send');assert.deepEqual((await current())[0].tags,['人工复核','GIS']);
  // Closing during a pending request cannot apply a late result or reopen.
  await context.route('**/api/classification/send',async r=>{await delay(600);await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({suggestions:[{paper_id:pid,folder_id:null,tags:['不应保存']}]})}).catch(()=>{});});await openOne();await page.locator('#orgStop').waitFor({state:'visible'});await cancel();await delay(800);assert.equal(await page.locator('#organizationDlg.open').count(),0);assert.deepEqual((await current())[0].tags,['人工复核','GIS']);await context.unroute('**/api/classification/send');
  assert.deepEqual(fs.readFileSync(path.join(library,pid,'source.pdf')),bytes);
  await page.screenshot({path:path.join(artifacts,'desktop-folders.png'),fullPage:true,animations:'disabled'});assert.deepEqual(errors,[]);
  console.log('Desktop browser: nested directories, descendant filters, persistent collapse, automatic suggestions/overrides, offline edits and late cancellation passed.');
}catch(error){
  fs.writeFileSync(path.join(artifacts,'failure.txt'),error.stack || String(error));
  if(page && !page.isClosed()){
    await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true,animations:'disabled'}).catch(e=>browserLog.push('Failure screenshot: '+e.message));
    fs.writeFileSync(path.join(artifacts,'failure.html'),await page.content().catch(()=>''));
    const fid=await page.evaluate(()=>Object.keys(window.PR?.lib?.organization?.folders || {})[0]).catch(()=>null);
    if(fid)layoutSamples.push({label:'failure',...await folderLayout(fid).catch(e=>({error:e.message}))});
  }
  throw error;
}finally{
  fs.writeFileSync(path.join(artifacts,'folder-layout.json'),JSON.stringify(layoutSamples,null,2));
  fs.writeFileSync(path.join(artifacts,'browser.log'),browserLog.join('\n')+'\n');
  fs.writeFileSync(path.join(artifacts,'errors.json'),JSON.stringify(errors,null,2));
  if(context)await context.tracing.stop({path:path.join(artifacts,'trace.zip')}).catch(e=>{console.error('Trace capture failed:',e);process.exitCode=1;});
  if(browser)await browser.close();
  if(server && server.exitCode===null && server.signalCode===null){
    const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;
  }
}})().catch(error=>{console.error(error);process.exitCode=1;});
