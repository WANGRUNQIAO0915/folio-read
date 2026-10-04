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
const errors=[];
async function wait(check,label){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await delay(80);}throw new Error('Timed out: '+label);}
async function post(route,body){return page.evaluate(async({route,body})=>{const r=await fetch(route,{method:'POST',headers:{'X-Token':PR.token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};},{route,body});}
async function openOne(){await page.locator('#list .row').first().click();await page.locator('#detail [data-organize-paper]').click();await page.locator('#organizationDlg.open').waitFor();}
async function cancel(){await page.locator('#organizationDlg [data-org-close]').first().click();await page.locator('#organizationDlg.open').waitFor({state:'hidden'});}
async function current(){return page.evaluate(()=>PR.lib.items);}
async function prepare(){await page.locator('#orgAI').click();await page.locator('#orgConsent').waitFor();assert.equal(await page.locator('#orgConsent').isChecked(),false);assert.equal(await page.locator('#orgSend').isDisabled(),true);assert.match(await page.locator('.org-provider').innerText(),/classification.example.invalid\/v1\/chat\/completions/);assert.match(await page.locator('.org-payload').innerText(),/Folio Offline Regression Fixture/);}
(async()=>{try{
  execFileSync(PYTHON,[support,'fixture',fixture],{cwd:temp,env});
  server=spawn(PYTHON,[support,'serve',guard,calls],{cwd:temp,env,stdio:['ignore','pipe','pipe']});let output='';
  server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>fs.appendFileSync(path.join(artifacts,'server.log'),b));
  await wait(()=>{const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)url=m[0];return !!url;},'server');
  browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===url||['data:','blob:'].includes(u.protocol)?r.continue():r.abort('blockedbyclient');});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForFunction(()=>!!PR.token);
  // Folder creation is a UI action and survives a refresh while still empty.
  await page.locator('[data-folder-create]').first().click();await page.locator('.cf-input').fill('手动资料');await page.locator('[data-cf="ok"]').click();
  await page.waitForFunction(()=>Object.values(PR.lib.organization.folders).some(f=>f.name==='手动资料'));
  let state=await page.evaluate(()=>PR.lib.organization);const fid=Object.keys(state.folders)[0];await page.reload();await page.locator('[data-folder="'+fid+'"]').waitFor();
  assert.ok(await page.locator('[data-folder="'+fid+'"] .t').evaluate(el=>el.getBoundingClientRect().width)>80,'folder name retains readable width beside menu button');
  assert.ok(await page.locator('[data-folder-more="'+fid+'"]').evaluate(el=>el.getBoundingClientRect().width)<=24,'folder menu stays compact');
  // Import into the chosen logical folder without AI.
  await page.locator('#importBtn').click();await page.locator('#importFolder').selectOption(fid);await page.locator('#fileInput').setInputFiles(fixture);
  await page.locator('#list .row').waitFor();let items=await current(),pid=items[0].id;assert.equal(items[0].folder_id,fid);assert.equal(countCalls(),0);
  const bytes=fs.readFileSync(path.join(library,pid,'source.pdf'));
  // Duplicate PDF remains in its existing folder and only one PDF exists.
  await page.locator('#importBtn').click();await page.locator('#importFolder').selectOption('');await page.locator('#fileInput').setInputFiles(fixture);await page.locator('#importDlg.open').waitFor({state:'hidden'});await page.waitForFunction(()=>PR.lib.items.length===1);assert.equal((await current())[0].folder_id,fid);
  // Manual tags, folder moves, stable rename, and no PDF changes.
  await openOne();await page.locator('[data-org-tags]').fill('遥感, 城市');await page.locator('#orgSave').click();await page.locator('#organizationDlg.open').waitFor({state:'hidden'});await page.waitForFunction(()=>PR.lib.items[0].tags.includes('城市'));
  assert.deepEqual((await current())[0].tags,['遥感','城市']);assert.deepEqual(fs.readFileSync(path.join(library,pid,'source.pdf')),bytes);
  await page.locator('[data-folder-more="'+fid+'"]').click();await page.getByText('重命名文件夹',{exact:true}).click();await page.locator('.cf-input').fill('热环境资料');await page.locator('[data-cf="ok"]').click();await page.waitForFunction(fid=>PR.lib.organization.folders[fid].name==='热环境资料',fid);assert.equal((await current())[0].folder_id,fid);
  // Cancel before sending transmits nothing and applies nothing.
  await openOne();await prepare();await cancel();assert.equal(countCalls(),0);assert.deepEqual((await current())[0].tags,['遥感','城市']);
  // Explicit opt-in + rapid repeated clicks sends only once. Result is reviewed first.
  await openOne();await prepare();await page.locator('#orgConsent').check();await page.locator('#orgSend').evaluate(el=>{el.click();el.click();});
  await page.locator('.org-message').waitFor();assert.equal(countCalls(),1);assert.deepEqual((await current())[0].tags,['遥感','城市']);
  await page.locator('[data-org-tags]').fill('人工复核, GIS');await page.screenshot({path:path.join(artifacts,'desktop-ai-review.png'),fullPage:true,animations:'disabled'});
  await page.locator('#orgSave').click();await page.locator('#organizationDlg.open').waitFor({state:'hidden'});await page.waitForFunction(()=>PR.lib.items[0].tags.includes('人工复核'));assert.equal((await current())[0].tags.length,2);
  // Failure and cancellation during request both preserve previous assignment.
  await context.route('**/api/classification/send',r=>r.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'模拟服务失败'})}));
  await openOne();await prepare();await page.locator('#orgConsent').check();await page.locator('#orgSend').click();await page.getByText(/生成失败：模拟服务失败/).waitFor();await cancel();assert.deepEqual((await current())[0].tags,['人工复核','GIS']);await context.unroute('**/api/classification/send');
  await context.route('**/api/classification/send',async r=>{await delay(600);await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({suggestions:[{paper_id:pid,folder_id:null,tags:['不应保存']}]})}).catch(()=>{});});
  await openOne();await prepare();await page.locator('#orgConsent').check();await page.locator('#orgSend').click();await cancel();await delay(800);assert.equal(await page.locator('#organizationDlg.open').count(),0);assert.deepEqual((await current())[0].tags,['人工复核','GIS']);await context.unroute('**/api/classification/send');
  // Existing tag UI remains connected to organization metadata.
  await page.locator('#list .row').click();await page.locator('#catInput').fill('兼容旧标签');await page.locator('#catInput').press('Enter');await page.waitForFunction(()=>PR.lib.items[0].tags.includes('兼容旧标签'));
  // Bulk select UI works, including Cancel/back without changing browser history.
  await page.locator('#batchSelect').click();await page.locator('[data-batch]').check();await page.locator('#organizeBtn').click();await cancel();assert.equal(page.url(),url+'/');await page.locator('#batchSelect').click();
  // Folder removal safely returns its papers to unclassified; tags/PDF survive.
  const assigned=(await current())[0].folder_id;await page.locator('[data-folder-more="'+assigned+'"]').click();await page.getByText('删除文件夹',{exact:true}).click();await page.locator('[data-cf="ok"]').click();await page.waitForFunction(()=>PR.lib.items[0].folder_id===null);assert.deepEqual(fs.readFileSync(path.join(library,pid,'source.pdf')),bytes);assert.ok((await current())[0].tags.includes('兼容旧标签'));
  await page.reload();await page.waitForFunction(()=>PR.lib.items.length===1);assert.equal((await current())[0].folder_id,null);assert.ok((await current())[0].tags.includes('兼容旧标签'));
  // Two-paper batch folder move and AI preview use both selected papers.
  const second=path.join(temp,'second.pdf');fs.writeFileSync(second,Buffer.concat([bytes,Buffer.from('\n% Second synthetic identity\n')]));
  await page.locator('#importBtn').click();await page.locator('#importFolder').selectOption('');await page.locator('#fileInput').setInputFiles(second);await page.waitForFunction(()=>PR.lib.items.length===2);
  await page.locator('#batchSelect').click();for(const input of await page.locator('[data-batch]').all())await input.check();await page.locator('#organizeBtn').click();assert.equal(await page.locator('[data-org-index]').count(),2);
  await page.locator('#orgBatchFolder').selectOption(fid);await page.locator('#orgBatchSet').click();await page.locator('#orgSave').click();await page.locator('#organizationDlg.open').waitFor({state:'hidden'});await page.waitForFunction(fid=>PR.lib.items.every(i=>i.folder_id===fid),fid);
  await page.locator('#organizeBtn').click();await prepare();await page.locator('#orgConsent').check();await page.locator('#orgSend').click();await page.locator('.org-message').waitFor();assert.equal(await page.locator('[data-org-index]').count(),2);assert.equal(countCalls(),2);await cancel();assert((await current()).every(i=>i.folder_id===fid));
  await page.screenshot({path:path.join(artifacts,'desktop-folders.png'),fullPage:true,animations:'disabled'});assert.deepEqual(errors,[]);
  console.log('Desktop classification browser: folder CRUD/import/move/tags, AI opt-in/review/cancel/error/repeat, persistence passed. No real provider or Google calls.');
}finally{if(browser)await browser.close();if(server){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}}})().catch(error=>{console.error(error);process.exitCode=1;});
