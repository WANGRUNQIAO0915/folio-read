// Rendered Chromium regression with synthetic API and PDF. No external / model traffic.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT || 'playwright');
const ROOT=path.resolve(__dirname,'../easyread/web');
const artifacts=path.resolve(process.env.BROWSER_ARTIFACTS || path.join(__dirname,'shots','naming'));
fs.mkdirSync(artifacts,{recursive:true});
const pdfBytes=Buffer.from('%PDF-1.4\n% synthetic naming regression; byte-identical download\n%%EOF\n');
const base={tags:[],status:'unread',notes:0,highlights:0,open_questions:0,discussions:0,added:'2026-01-01',pages:1,done_pages:0};
let items=[{...base,id:'p001',title_en:'Synthetic source title: urban climate',title_zh:'已有中文标题',display_title:'已有中文标题',original_filename:'urban-climate.pdf',pdf_filename:'urban-climate.pdf'},{...base,id:'p002',title_en:'Second synthetic source title',display_title:'Second synthetic source title',original_filename:'source-2.pdf',pdf_filename:'source-2.pdf'}];
const source=i=>({paper_id:i.id,title:i.display_title,source:i.naming?.source || (i.title_zh?'existing_chinese':'bibliographic_metadata'),original_title:i.title_en,original_filename:i.original_filename,expected_version:i.naming?.version || '',pdf_filename:i.pdf_filename});
let server,browser,context,page,origin,saves=0,sends=0,cancels=0,previews=0,mode='',previewIds=[],pendingReply;
const errors=[],external=[],pdfDownloads=[];const clone=x=>JSON.parse(JSON.stringify(x));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(check,label){for(let until=Date.now()+15000;Date.now()<until;){if(await check())return;await delay(40);}throw Error('Timed out: '+label);}
async function open(ids=['p001']){await page.evaluate(ids=>PR.lib.openNaming(ids),ids);await page.locator('[data-naming-title]').first().waitFor();}
async function close(){await page.locator('#namingDlg [data-naming-close]').first().click();await page.locator('#namingDlg.open').waitFor({state:'hidden'});}
async function preview(){await page.locator('#namingAI').click();await page.locator('#namingConsent').waitFor();assert.equal(await page.locator('#namingConsent').isChecked(),false);assert.equal(await page.locator('#namingSend').isDisabled(),true);assert.match(await page.locator('.naming-provider').innerText(),/naming.example.invalid\/v1\/chat\/completions/);assert.match(await page.locator('.naming-payload').innerText(),/EXACT DISCLOSED TEXT/);}
(async()=>{try{
 server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  // Chromium's download= links can bypass Playwright request interception.
  // Serve the fixture over real HTTP so this path exercises response headers
  // and bytes whether Chromium routes the download through CDP or directly.
  if(name==='/api/p/p001/pdf' && ['GET','HEAD'].includes(req.method)){
   const disposition="attachment; filename=paper.pdf; filename*=UTF-8''"+encodeURIComponent(items[0].pdf_filename);
   pdfDownloads.push({method:req.method,url:name,filename:items[0].pdf_filename,bytes:pdfBytes.length});
   res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':disposition,'Content-Length':pdfBytes.length,'X-Content-Type-Options':'nosniff'});
   return res.end(req.method==='HEAD'?undefined:pdfBytes);
  }
  const file=path.resolve(ROOT,name==='/'?'library.html':name.startsWith('/read/')?'reader.html':name.replace(/^\/web\//,''));
  if(!file.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end();}
  try{const body=fs.readFileSync(file),ext=path.extname(file);res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[ext] || 'application/octet-stream'});res.end(body);}catch{res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 // Validate the actual fixture endpoint even on machines unable to launch Chromium.
 const probe=await fetch(origin+'/api/p/p001/pdf');assert.equal(probe.status,200);assert.equal(probe.headers.get('content-type'),'application/pdf');assert.match(probe.headers.get('content-disposition'),/filename\*=UTF-8''urban-climate\.pdf/);assert.deepEqual(Buffer.from(await probe.arrayBuffer()),pdfBytes);
 console.log('Naming download fixture HTTP headers and original bytes passed.');
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',acceptDownloads:true});
 await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  if(url.origin!==origin){external.push(req.url());return route.abort('blockedbyclient');}
  if(!p.startsWith('/api/'))return route.continue();
  const body=req.method()==='POST'?req.postDataJSON():{};let data={},status=200;
  if(p==='/api/library')data={items:clone(items),organization:{folders:{},assignments:{}},token:'synthetic',engine:'none',engine_label:'不翻译',first_run:false};
  else if(p==='/api/prefs')data={library:{cats:[],hidden:[],pinned:[]}};
  else if(p==='/api/engines')data={ready:true,found:{}};
  else if(p==='/api/chat/models')data={models:[],default:''};
  else if(p==='/api/research')data={topics:[],records:[]};
  else if(p==='/api/study/meta')data={id:'p001',sections:[],assets:[]};
  else if(p==='/api/study/history')data={runs:[]};
  else if(p==='/api/p/p001/state')data={token:'synthetic',item:clone(items[0]),paper:{meta:{title_en:items[0].title_en,title_zh:items[0].title_zh,authors:'Synthetic author',pages:[],text_status:'original'},blocks:[{id:'para-1',type:'para',en:'Synthetic original paragraph.'}]},discussion:{entries:[]},reader:{},layout:{},versions:{},engine:'none'};
  else if(p==='/api/naming/suggest')data={suggestions:items.filter(i=>body.paper_ids.includes(i.id)).map(source)};
  else if(p==='/api/naming/preview'){
   previews++;previewIds=body.paper_ids;data={id:'naming-'+previews,provider:'Mock translator',endpoint:'https://naming.example.invalid/v1/chat/completions',model:'mock-title-translator',messages:[{role:'system',content:'Translate title only'},{role:'user',content:'EXACT DISCLOSED TEXT\nSynthetic source title: urban climate'}],papers:previewIds};
   if(mode==='late-preview')await new Promise(r=>pendingReply=r);
  }
  else if(p==='/api/naming/send'){
   sends++;assert.equal(body.confirmed,true);
   if(mode==='failure'){status=400;data={error:'模拟模型故障'};}
   else {data={suggestions:items.filter(i=>previewIds.includes(i.id)).map(i=>({...source(i),title:'AI 城市气候研究',source:'ai_translation',pdf_filename:'AI 城市气候研究.pdf'}))};if(mode==='late-send')await new Promise(r=>pendingReply=r);}
  }
  else if(p==='/api/naming/cancel'){cancels++;data={state:'cancelled'};}
  else if(p==='/api/naming/apply'){
   saves++;for(const s of body.suggestions){const i=items.find(i=>i.id===s.paper_id);assert.equal(s.expected_version,i.naming?.version || '');Object.assign(i,{display_title:s.title,pdf_filename:s.title+'.pdf',naming:{title:s.title,source:s.source,version:'v'+saves}});}
   data={items:clone(items),suggestions:items.map(source)};
  }
  else if(p==='/api/p/p001/pdf')return route.continue();
  return route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
 });
 page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(origin);await page.waitForFunction(()=>window.PR?.lib?.items?.length===2);
 // Single-item entry is visible, originals are readable, and keyboard focus is contained.
 await page.locator('[data-id="p001"]').click();await page.locator('[data-name-paper]').click();await page.locator('[data-naming-title]').waitFor();
 assert.equal(sends,0);assert.equal(saves,0);assert.match(await page.locator('.naming-original').innerText(),/urban-climate.pdf/);
 await page.locator('#namingSave').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-naming-close')),true);
 await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'namingSave');
 await page.locator('[data-naming-title]').fill('手动中文显示名');await page.keyboard.press('Escape');await page.locator('#namingDlg.open').waitFor({state:'hidden'});assert.equal(saves,0);assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-name-paper')),true);
 await open();await page.locator('[data-naming-title]').fill('手动中文显示名');await page.locator('#namingSave').evaluate(el=>{el.click();el.click();});await page.locator('#namingDlg.open').waitFor({state:'hidden'});assert.equal(saves,1);assert.equal(items[0].title_en,'Synthetic source title: urban climate');
 await page.waitForFunction(()=>document.querySelector('[data-id="p001"] .t1').textContent.includes('手动中文显示名'));
 assert.match(await page.locator('#detail .naming-metadata').innerText(),/Synthetic source title/);
 // Exact model preview and Cancel make no model call. Returning retains local edits.
 await open();await page.locator('[data-naming-title]').fill('仍是本地草稿');await preview();assert.equal(sends,0);await page.screenshot({path:path.join(artifacts,'desktop-naming-consent.png'),fullPage:true});
 await page.locator('#namingBack').click();assert.equal(await page.locator('[data-naming-title]').inputValue(),'仍是本地草稿');await preview();await close();assert.equal(sends,0);assert.equal(saves,1);
 // Review an AI result before saving; duplicates coalesce and provenance stays visible.
 await open();await preview();await page.locator('#namingConsent').check();await page.locator('#namingSend').evaluate(el=>{el.click();el.click();});await page.locator('.naming-message').waitFor();assert.equal(sends,1);assert.equal(saves,1);assert.match(await page.locator('.naming-source').innerText(),/非官方译名/);
 await page.screenshot({path:path.join(artifacts,'desktop-naming-ai-review.png'),fullPage:true});await page.locator('#namingSave').click();await page.locator('#namingDlg.open').waitFor({state:'hidden'});assert.equal(saves,2);
 // Original PDF downloads under the reviewed Chinese name, byte-for-byte unchanged.
 const downloadsBefore=pdfDownloads.length;
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#detail a[download]').click()]);assert.equal(download.suggestedFilename(),'AI 城市气候研究.pdf');const downloaded=await download.path();assert.deepEqual(fs.readFileSync(downloaded),pdfBytes);
 assert(pdfDownloads.slice(downloadsBefore).some(r=>r.method==='GET' && r.filename==='AI 城市气候研究.pdf'),'Browser download reached the HTTP PDF fixture');
 // Opening the reader uses the saved display title and still exposes original metadata.
 await page.locator('#detail a[href="/read/p001"]').click();await page.locator('.paper-head h1').waitFor();
 assert.equal(await page.locator('.paper-head h1').innerText(),'AI 城市气候研究');assert.equal(await page.locator('.bar-title').innerText(),'AI 城市气候研究');assert.match(await page.locator('.paper-naming-source').innerText(),/非官方/);
 await page.locator('.paper-information summary').click();assert.match(await page.locator('.paper-information').innerText(),/Synthetic source title: urban climate/);
 // The reading workspace intentionally hides the legacy #backBtn. Use its visible library navigation.
 await page.locator('#workspaceNav').getByRole('link',{name:'文献库',exact:true}).click();await page.waitForFunction(()=>window.PR?.lib?.items?.length===2);assert.match(await page.locator('#resumeReading').innerText(),/AI 城市气候研究/);
 // Model failure is editable; cancelled late sends cannot overwrite a newer dialog.
 mode='failure';await open();await preview();await page.locator('#namingConsent').check();await page.locator('#namingSend').click();await page.locator('#namingError').filter({hasText:'模拟模型故障'}).waitFor();await close();assert.equal(saves,2);
 mode='late-send';await open();await preview();await page.locator('#namingConsent').check();await page.locator('#namingSend').click();await wait(()=>!!pendingReply,'pending send');let release=pendingReply;pendingReply=null;await close();mode='';await open(['p002']);await page.locator('[data-naming-title]').fill('新窗口草稿');release();await delay(100);assert.equal(await page.locator('[data-naming-title]').inputValue(),'新窗口草稿');await close();assert.equal(saves,2);
 mode='late-preview';await open();await page.locator('#namingAI').click();await wait(()=>!!pendingReply,'pending preview');release=pendingReply;pendingReply=null;await close();mode='';release();await delay(100);assert.equal(await page.locator('#namingDlg.open').count(),0);
 // Batch entry and narrow desktop dialog both fit and preserve original titles.
 await page.setViewportSize({width:700,height:800});
 // Resizing retains an open desktop filter sidebar as a drawer over the rows.
 // Dismiss it through the visible control before selecting papers underneath.
 if(await page.locator('#libraryFilter').getAttribute('aria-expanded')==='true')await page.locator('#libraryFilter').click();
 await page.locator('#batchSelect').click();await page.locator('[data-batch="p001"]').check();await page.locator('[data-batch="p002"]').check();const toolbar=await page.locator('.list-head').evaluate(el=>{const b=el.querySelector('#namingBtn').getBoundingClientRect(),r=el.getBoundingClientRect();return{buttonLeft:b.left,buttonRight:b.right,left:r.left,right:r.right,scroll:el.scrollWidth,client:el.clientWidth};});assert(toolbar.buttonLeft>=toolbar.left && toolbar.buttonRight<=toolbar.right && toolbar.scroll<=toolbar.client+1,JSON.stringify(toolbar));await page.locator('#namingBtn').click();await page.locator('[data-naming-index]').nth(1).waitFor();
 assert.equal(await page.locator('[data-naming-title]').count(),2);await page.locator('[data-naming-title]').nth(0).fill('批量中文一');await page.locator('[data-naming-title]').nth(1).fill('批量中文二');
 const layout=await page.locator('#namingDlg .dialog').evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width,scroll:el.scrollWidth,client:el.clientWidth,window:innerWidth};});assert(layout.x>=0 && layout.right<=layout.window && layout.scroll<=layout.client+1,JSON.stringify(layout));
 await page.screenshot({path:path.join(artifacts,'desktop-naming-batch-narrow.png'),fullPage:true});await page.locator('#namingSave').click();await page.locator('#namingDlg.open').waitFor({state:'hidden'});assert.equal(saves,3);assert.deepEqual(items.map(i=>i.display_title),['批量中文一','批量中文二']);
 assert.equal(page.url(),origin+'/');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert(cancels>=5);
 console.log('Desktop naming Chromium passed: consent, original-title provenance, focus trap/Escape, single/batch apply, cancellation races, narrow layout, safe named original-byte download.');
}finally{
 if(context)await context.tracing.stop({path:path.join(artifacts,'trace.zip')}).catch(()=>{});
 if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));
 fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({saves,sends,cancels,errors,external,pdfDownloads},null,2));
}})().catch(e=>{console.error(e);process.exitCode=1;});
