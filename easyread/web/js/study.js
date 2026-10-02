(function(PR){
  'use strict';
  PR.mountStudy = function(root, options={}) {
  const embedded=!!options.embedded;
  const $=s=>root.querySelector(s), $$=s=>Array.from(root.querySelectorAll(s)), esc=PR.esc;
  const params=new URLSearchParams(location.search);
  const modeKey=embedded?'tool':'mode', runKey=embedded?'analysis':'run';
  function updateUrl(key,value){const url=new URL(location.href);if(value)url.searchParams.set(key,value);else url.searchParams.delete(key);history.replaceState(history.state,'',url);}
  if(!embedded && params.get('paper') && ['question','overview','visual','section'].includes(params.get('mode'))){
    const next=new URL('/read/'+encodeURIComponent(params.get('paper')),location.origin);
    next.searchParams.set('tool',params.get('mode')==='section'?'overview':params.get('mode'));
    for(const key of ['asset','source_page'])if(params.get(key))next.searchParams.set(key,params.get(key));
    if(params.get('run'))next.searchParams.set('analysis',params.get('run'));
    location.replace(next);return;
  }
  const S={papers:[], meta:null, mode:null, views:{}, history:[], recordFilter:'all', comments:{}, topic:PR.ls.get('easyread-study-topic',''), run:null, active:null, poll:null, crop:null, research:{topics:[],records:[]}};
  const MODES={
    question:['全文问答','围绕当前论文提问，点击回答中的引文核对原文。'],
    knowledge:['问资料库','从收藏文章和笔记中查找依据，综合回答你的问题。'],
    overview:['概览与精读','先了解问题、方法、结果与边界，再深入章节。'],
    visual:['图表与公式','结合原图、题注和正文解读。可框选图中区域。'],
    compare:['围绕一个问题比较多篇论文','比较研究对象、数据、方法、验证、结果和边界。每个单元格附本篇出处，不直接跨数据集排名。'],
    research:['我的研究记录','']
  };
  const kindName={source:'收藏论文 · 引文已定位',note:'我的笔记',interpretation:'基于资料的解释',general:'库外补充 · 模型通用知识',uncertain:'待核实'};
  const modeName={question:'全文问答',knowledge:'资料库问答',overview:'论文概览',section:'章节精读',visual:'图表公式',compare:'多篇比较'};
  function notify(message,error=false){const n=$('#studyNotice');n.hidden=false;n.classList.toggle('error',error);n.textContent=message;}
  async function api(path,body){return PR.api(path,body===undefined?undefined:{method:'POST',body});}
  function paperTitle(id){const p=S.papers.find(p=>p.id===id);return p?(p.title_zh||p.title_en||id):id;}
  function plainLink(url){return typeof url==='string'&&/^\/read\/[A-Za-z0-9_-]+(?:[?#].*)?$/.test(url)?url:'#';}
  function evidenceHtml(s){return '<div class="evidence"><a data-source href="'+esc(plainLink(s.url))+'">'+esc(s.title)+' · '+(s.page?'第 '+esc(s.page)+' 页':'整篇论文')+' · '+esc(s.origin||'来源')+' · 定位原文 →</a>'+(s.quote?'<blockquote>'+esc(s.quote)+'</blockquote>':'')+(s.unresolved?'<span class="claim-warn">原段落位置变化，需要重新定位</span>':'')+'</div>';}
  function evidenceGroup(sources){
    if(!sources.length)return '';
    return '<details class="evidence-group"><summary>查看依据 · '+sources.length+' 处</summary><div>'+sources.map(evidenceHtml).join('')+'</div></details>';
  }
  function claimHtml(c,path){return '<article class="claim" tabindex="0" aria-label="'+esc(kindName[c.kind]||'待核实')+'；聚焦可保存到主题"><span class="claim-kind '+esc(c.kind)+'">'+esc(kindName[c.kind]||'待核实')+'</span><div class="claim-text">'+PR.mdBlocks(c.text,{xref:false,cite:false})+'</div>'+(c.warnings||[]).map(w=>'<p class="claim-warn">'+esc(w)+'</p>').join('')+'<div class="claim-tools">'+evidenceGroup(c.citations||[])+'<button class="pin-claim" data-pin="'+path+'">保存到主题</button></div></article>';}
  function renderRun(run){
    S.run=run;
    updateUrl(runKey,run.id);
    if(run.state!=='done'){$('#studyResult').innerHTML='';return;}
    root.classList.add('analysis-collapsed');
    let html='<div class="answer-heading"><span class="answer-saved">'+esc(modeName[run.mode]||run.mode)+' · 已保存</span>'+(['question','knowledge'].includes(run.mode)?'<button class="btn accent sm" data-focus-followup>继续提问 ↓</button>':'')+'<button class="btn line sm" data-edit-run>修改问题</button>'+(run.question?'<h2>'+esc(run.question.split('\n所选对象：')[0])+'</h2>':'')+'</div>';
    let scope='';
    if(run.mode==='knowledge'){
      const r=run.retrieval||{};
      const cited=new Set(run.result.sections.flatMap(s=>s.claims.flatMap(c=>(c.citations||[]).map(x=>x.paper))));
      html+='<div class="answer-scope"><span>'+esc(run.category||'全部收藏文章')+' · '+esc(r.scope_papers||0)+' 篇</span><span>回答引用 '+cited.size+' 篇</span></div>';
      scope='本次提供 '+esc(r.selected_passages||0)+' 段候选材料。'+(r.limited?'检索有容量限制，可能还有未展示的材料。':'');
      if(!r.selected_passages)html+='<p class="claim-warn">本次没有检索到相关资料，不能据此判断整个库中不存在相关内容。'+(run.allow_general?'下方库外补充来自模型通用知识。':'已限制为库内回答。')+'</p>';
      if(run.retrieval_warning)html+='<p class="claim-warn">'+esc(run.retrieval_warning)+'</p>';
      if((r.errors||[]).length||(r.unreadable||[]).length)html+='<p class="claim-warn">'+esc((r.errors||[]).length)+' 篇文件读取失败，'+esc((r.unreadable||[]).length)+' 篇暂无可检索文字；扫描件需先提取文字。</p>';
    }
    html+='<details class="coverage"><summary>来源与分析说明</summary><p>'+scope+esc(run.model)+' · '+esc(PR.shortTime(run.created))+'</p><p>'+(run.coverage||[]).map(c=>esc(paperTitle(c.paper))+': 使用 '+c.selected+' / '+c.total+' 段材料').join('；')+'。结果依据本次提供的材料；引文定位通过不等于结论已经得到验证。</p>'+(run.mode==='visual'?'<p>'+(run.image_sent?'模型已收到'+(run.crop?'框选的原图区域':'原图 / 所在页'):'本次只使用文字与题注，未发送图像。')+'</p>':'')+'</details>';
    if(embedded && run.mode==='overview' && S.meta){html+='<details class="section-route"><summary>继续读原文 →</summary>'+S.meta.sections.map(s=>'<button class="section-read" data-section-read="'+esc(s.id)+'">'+esc(s.title)+' · p.'+esc(s.page||'?')+' →</button>').join('')+'</details>';}
    if((run.result.rows||[]).length){html+='<div class="comparison-wrap"><table class="comparison-table"><thead><tr><th>维度</th>'+run.papers.map(id=>'<th>'+esc(paperTitle(id))+'</th>').join('')+'</tr></thead><tbody>'+run.result.rows.map((r,i)=>'<tr><th>'+esc(r.dimension)+'</th>'+r.cells.map((c,j)=>'<td>'+claimHtml(c,'rows:'+i+':'+j)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
    html+='<div class="answer-document">'+run.result.sections.map((s,i)=>'<section class="result-section"><h2>'+esc(s.title)+'</h2>'+s.claims.map((c,j)=>claimHtml(c,'sections:'+i+':'+j)).join('')+'</section>').join('')+'</div>';
    if((run.result.followups||[]).length)html+='<section class="followup-suggestions"><h2>值得继续查的问题</h2>'+run.result.followups.map(q=>'<button data-follow="'+esc(q)+'">'+esc(q)+' <span aria-hidden="true">↗</span></button>').join('')+'</section>';
    if(['question','knowledge'].includes(run.mode))html+='<div class="followup-composer"><label class="field"><span>继续提问</span><textarea class="input" id="followupQuestion" rows="2" maxlength="4000" placeholder="输入下一个问题，继续查找资料…"></textarea></label><div class="study-actions"><button class="btn accent" data-send-followup>查资料并回答</button><span class="hint">每次提问单独保存到问答记录</span></div></div>';
    $('#studyResult').innerHTML=html;
    renderHistory();
  }
  function setMode(mode){
    if(!MODES[mode])mode=embedded?'question':'research';
    if(S.active && S.mode!==mode){notify('分析仍在进行，请等待完成或先停止。');return;}
    const changed=mode!==S.mode;
    if(changed && S.mode)S.views[S.mode]={run:S.run,question:$('#studyQuestion').value,level:$('#studyLevel').value,section:$('#studySection').value,asset:$('#studyAsset').value};
    S.mode=mode;
    root.classList.toggle('knowledge-mode',mode==='knowledge');
    root.classList.toggle('research-mode',mode==='research');
    root.classList.toggle('compare-mode',mode==='compare');
    root.classList.remove('topic-create-open');
    if(!embedded){
      const knowledgeMode=['knowledge','compare'].includes(mode);
      document.title='Folio Read · '+(knowledgeMode?'知识问答':'研究主题');
      $('.workspace-heading h1').textContent=knowledgeMode?'知识问答':'研究主题';
      $('.workspace-heading .hint').textContent=knowledgeMode?'让收藏文章和阅读笔记，成为回答问题的依据。':'把阅读中的证据、判断和问题，整理成可继续推进的研究。';
      for(const [id,on] of [['knowledgeNav',knowledgeMode],['researchNav',!knowledgeMode]]){const a=document.getElementById(id);if(a){if(on)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}}
      const collection=$('.knowledge-collection');if(collection){collection.open=false;collection.querySelector('summary').hidden=false;}
      $('.study-tabs').hidden=!knowledgeMode;
      $('.history-disclosure').hidden=mode==='research';
      $('.topic-region').hidden=mode!=='research';
      $('.analysis-options').hidden=mode==='research';
    }
    if(changed){S.run=null;$('#studyResult').innerHTML='';$('#studyQuestion').value='';$('#taskStatus').textContent='';$('#studyNotice').hidden=true;updateUrl(runKey,'');root.classList.remove('analysis-collapsed');}
    updateUrl(modeKey,mode);if(options.onMode)options.onMode(mode);
    $$('[data-study-mode]').forEach(b=>{b.classList.toggle('on',b.dataset.studyMode===mode);b.setAttribute('aria-pressed',String(b.dataset.studyMode===mode));});
    $('#analysisForm').hidden=mode==='research';$('#researchPanel').hidden=mode!=='research';$('#studyResult').hidden=mode==='research';
    $('#modeTitle').textContent=MODES[mode][0];$('#modeHint').textContent=MODES[mode][1];
    $('.history-disclosure > summary').textContent=embedded?'陪读记录':mode==='compare'?'比较记录':'问答记录';
    $('#overviewControls').hidden=mode!=='overview';$('#visualControls').hidden=mode!=='visual';$('#compareControls').hidden=mode!=='compare';
    $('#questionScopeControls').hidden=!embedded||!['question','knowledge'].includes(mode);
    $('#questionScope').value=mode==='knowledge'?'library':'paper';
    $('#knowledgeControls').hidden=mode!=='knowledge';
    if(mode==='knowledge')$('#studyQuestion').closest('label').after($('#knowledgeControls'));
    $('#startStudy').textContent=mode==='knowledge'?'查资料并回答':mode==='question'?'提问':'开始分析';
    $('#startStudy').disabled=!!S.active||(mode==='knowledge'?!S.papers.length:!S.meta);
    $('#questionLabel').textContent=['question','knowledge'].includes(mode)?'你想理解什么？':mode==='compare'?'比较围绕的共同问题':'希望重点解释什么？（可留空）';
    $('#studyQuestion').placeholder=mode==='knowledge'?'例如：收藏文献对这个问题有哪些结论？哪些存在分歧？':mode==='compare'?'例如：这些研究的数据、方法和结论有哪些差异？':'例如：作者的方法依赖哪些假设？实验是否支持这些假设？';
    if(changed && S.views[mode]){const v=S.views[mode];$('#studyQuestion').value=v.question;$('#studyLevel').value=v.level;$('#studySection').value=v.section;$('#sectionField').hidden=v.level!=='section';if(mode==='visual'){$('#studyAsset').value=v.asset;loadAsset();}if(v.run)renderRun(v.run);}
    if(mode==='research')renderResearch();
    renderHistory();
  }
  async function loadPaper(){
    const pid=$('#studyPaper').value;S.run=null;S.views={};$('#studyResult').innerHTML='';updateUrl(runKey,'');root.classList.remove('analysis-collapsed');
    if(!embedded)updateUrl('paper',pid);
    S.crop=null;
    if(!pid){S.meta=null;$('#startStudy').disabled=true;return;}
    S.meta=await api('/api/study/meta?paper='+encodeURIComponent(pid));
    $('#backPaper').href='/read/'+encodeURIComponent(pid);
    $('#studySection').innerHTML=S.meta.sections.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.title)+' · p.'+esc(s.page||'?')+'</option>').join('');
    $('#studyAsset').innerHTML=S.meta.assets.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.label)+' · p.'+esc(a.page||'?')+'</option>').join('');
    if(params.get('asset')&&S.meta.assets.some(a=>a.id===params.get('asset')))$('#studyAsset').value=params.get('asset');
    $('#startStudy').disabled=false;
    $('#zoteroQuery').value=paperTitle(pid).replace(/^\[示例\]\s*/,'');
    renderZoteroLink();loadAsset();await loadHistory();
  }
  function loadAsset(){
    S.crop=null;$('#cropBox').hidden=true;$('#clearCrop').hidden=true;
    const asset=S.meta&&S.meta.assets.find(a=>a.id===$('#studyAsset').value);
    $('#assetFormula').innerHTML=asset&&asset.tex?PR.tex(asset.tex,true):'';
    $('#assetCaption').textContent=asset?asset.text:'';
    const image=$('#visualImage');$('#cropStage').hidden=true;
    $('#imageHint').textContent=asset?'正在读取原图…':'本篇尚无识别出的图表或公式。完成翻译后再试。';
    image.onload=()=>{$('#cropStage').hidden=false;$('#imageHint').textContent='原图 / 所在页。可以在图上拖动，框选想解读的区域。';};
    image.onerror=()=>{$('#cropStage').hidden=true;$('#imageHint').textContent='原图暂不可用，可以根据正文、题注或公式进行文字解读。';};
    if(asset)image.src='/api/study/image?paper='+encodeURIComponent(S.meta.id)+'&asset='+encodeURIComponent(asset.id);
    else image.removeAttribute('src');
  }
  async function loadHistory(){
    const d=await api('/api/study/history'+(embedded?'?paper='+encodeURIComponent($('#studyPaper').value):''));
    S.history=d.runs;renderHistory();
  }
  function renderHistory(){
    const runs=S.history.filter(r=>embedded?r.mode!=='compare':r.mode===(S.mode==='compare'?'compare':'knowledge'));
    const selected=S.active||(S.run&&S.run.id);
    $('#studyHistory').innerHTML=runs.map(r=>'<button data-history="'+esc(r.id)+'"'+(r.id===selected?' aria-current="true"':'')+'><span class="history-title">'+esc((r.question||paperTitle((r.papers||[])[0])).split('\n所选对象：')[0])+'</span><span class="history-meta">'+esc(PR.shortTime(r.created))+' · '+esc(({done:'已保存',running:'分析中',queued:'排队中',error:'失败',cancelled:'已停止'})[r.state]||r.state)+'</span></button>').join('')||'<p class="hint">提问后会自动保存，随时回来查看。</p>';
    $('#newStudy').textContent=S.mode==='compare'?'＋ 新比较':'＋ 新提问';
  }
  function restoreForm(run){
    setMode(run.mode==='section'?'overview':run.mode);
    $('#studyQuestion').value=(run.question||'').split('\n所选对象：')[0];
    if(run.mode==='section'){$('#studyLevel').value='section';$('#sectionField').hidden=false;$('#studySection').value=run.section;}
    if(run.mode==='overview'){$('#studyLevel').value='overview';$('#sectionField').hidden=true;}
    if(run.mode==='visual'){$('#studyAsset').value=run.asset;loadAsset();}
    if(run.mode==='knowledge'){$('#knowledgeCategory').value=run.category||'';$('#knowledgeNotes').checked=run.include_notes!==false;$('#knowledgeGeneral').checked=run.allow_general!==false;}
    $$('[data-compare]').forEach(input=>{input.checked=(run.papers||[]).includes(input.value);});
  }
  function setBusy(busy){$('#startStudy').disabled=busy||(S.mode==='knowledge'?!S.papers.length:!S.meta);$('#stopStudy').hidden=!busy;for(const id of ['studyPaper','studyModel','studyAsset','studyLevel','studySection','questionScope','knowledgeCategory','knowledgeNotes','knowledgeGeneral'])$('#'+id).disabled=busy;$$('[data-compare]').forEach(n=>n.disabled=busy);}
  async function poll(rid){
    try{
      const run=await api('/api/study/run?id='+encodeURIComponent(rid));
      $('#taskStatus').textContent=run.message||'';
      if(['queued','running'].includes(run.state)){
        S.active=rid;setBusy(true);S.poll=setTimeout(()=>poll(rid),1800);
      }else{
        S.active=null;setBusy(false);renderRun(run);await loadHistory();
        if(run.state==='error')notify('分析失败：'+run.message,true);
        if(run.state==='done')$('#studyNotice').hidden=true;
      }
    }catch(e){setBusy(false);notify('无法读取分析进度：'+e.message+'。可以从最近分析重新打开。',true);}
  }
  async function start(){
    if(S.active)return;
    const mode=S.mode==='overview'?$('#studyLevel').value:S.mode;
    const papers=mode==='compare'?Array.from($$('[data-compare]:checked')).map(x=>x.value):[$('#studyPaper').value];
    const body={mode,papers,question:$('#studyQuestion').value,model:$('#studyModel').value,section:$('#studySection').value,asset:$('#studyAsset').value,crop:S.crop,category:$('#knowledgeCategory').value,include_notes:$('#knowledgeNotes').checked,allow_general:$('#knowledgeGeneral').checked};
    root.classList.remove('analysis-collapsed');setBusy(true);
    try{const task=await api('/api/study/run',body);S.active=task.id;updateUrl(runKey,task.id);$('#studyResult').innerHTML='';$('#taskStatus').textContent='正在准备原文依据…';await poll(task.id);}
    catch(e){setBusy(false);notify(e.message,true);}
  }
  async function loadResearch(){
    S.research=await api('/api/research');
    const current=S.topic||$('#studyTopic').value;
    $('#studyTopic').innerHTML='<option value="">请选择主题</option>'+S.research.topics.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.title)+'</option>').join('');
    if(S.research.topics.some(t=>t.id===current))$('#studyTopic').value=current;
    else if(S.mode==='research'&&S.research.topics.length)$('#studyTopic').value=S.research.topics[0].id;
    S.topic=$('#studyTopic').value;renderResearch();
  }
  function renderResearch(){
    const tid=$('#studyTopic').value;S.topic=tid;
    PR.ls.set('easyread-study-topic',tid);
    const topic=S.research.topics.find(t=>t.id===tid);
    $('#activeTopicTitle').textContent=topic?topic.title:'从一个研究问题开始';
    $('#studyTopics').innerHTML=S.research.topics.map(t=>'<button data-topic="'+esc(t.id)+'"'+(t.id===tid?' aria-current="true"':'')+'><span>'+esc(t.title)+'</span><small>'+S.research.records.filter(r=>r.topic===t.id).length+' 条记录</small></button>').join('')||'<p class="hint">把文章中的证据和你的判断，整理到一个主题。</p>';
    if(embedded && $('.reader-collection > summary'))$('.reader-collection > summary').textContent=topic?'收集到 · '+topic.title:'选择研究主题';
    $('#topicDescription').textContent=topic?(topic.question||topic.title):'选一个研究主题，收集证据、判断和待核实问题。';
    for(const [id,fmt] of [['exportObsidian','zip'],['exportMarkdown','md'],['exportRIS','ris']]){const a=$('#'+id);a.href='/api/research/export?topic='+encodeURIComponent(tid)+'&format='+fmt;a.hidden=!tid;}
    const allRecords=S.research.records.filter(r=>r.topic===tid);
    const filters=[['all','全部'],['source','论文证据'],['judgment','判断'],['question','待核实']];
    $('#recordFilters').innerHTML=filters.map(([key,label])=>'<button data-record-filter="'+key+'" aria-pressed="'+(S.recordFilter===key)+'" class="'+(S.recordFilter===key?'on':'')+'">'+label+' '+allRecords.filter(r=>key==='all'||r.kind===key).length+'</button>').join('');
    const records=allRecords.filter(r=>S.recordFilter==='all'||r.kind===S.recordFilter);
    $('#collectNotes').disabled=!tid;$('#addRecord').disabled=!tid;
    $('#recordFilters').hidden=!tid;
    $('#researchRecords').innerHTML=records.map(r=>'<article class="record-card" data-record="'+esc(r.id)+'"><span class="record-meta">'+esc(({source:'论文证据 · AI 提取',judgment:'我的判断',question:r.status==='done'?'问题 · 已处理':'待核实问题'})[r.kind])+' · '+esc(PR.shortTime(r.updated))+'</span><div>'+PR.mdBlocks(r.text,{xref:false,cite:false})+'</div>'+evidenceGroup(r.evidence||[])+'<details class="record-comment"'+((S.comments[r.id]??r.comment)?' open':'')+'><summary>补充笔记</summary><label class="field"><span>我的补充</span><textarea class="input" data-comment rows="2">'+esc(S.comments[r.id]??r.comment??'')+'</textarea></label><div class="record-actions"><button class="btn sm line" data-record-save="'+esc(r.id)+'">保存补充</button></div></details>'+(r.kind==='question'?'<div class="record-actions"><button class="btn sm line" data-record-status="'+esc(r.id)+'">'+(r.status==='done'?'重新标为待处理':'标为已处理')+'</button></div>':'')+'</article>').join('')||'<div class="research-empty"><h3>'+(tid?'这里还没有'+(S.recordFilter==='all'?'记录':filters.find(f=>f[0]===S.recordFilter)[1]):'建立自己的研究主题')+'</h3><p class="hint">'+(tid?'阅读时保存结论、收集论文笔记，或写下待解决的问题。':'例如“城市绿地降温机制”，逐步收集证据、笔记与待核实问题。')+'</p>'+(!tid?'<button class="btn accent" data-new-topic>新建主题</button>':'')+'</div>';
  }
  function renderZoteroLink(){const link=S.meta&&S.meta.zotero;$('#zoteroLinked').innerHTML=link?'<p>已关联：<a href="'+esc(link.url)+'">'+esc(link.title)+' ↗</a></p>':'';}
  const protect=fn=>async e=>{try{await ready;await fn(e);}catch(error){notify(error.message,true);}};
  $$('[data-study-mode]').forEach(b=>b.addEventListener('click',async()=>{await ready;setMode(b.dataset.studyMode);}));
  $('#studyPaper').addEventListener('change',protect(async()=>{if(S.active){$('#studyPaper').value=S.meta.id;throw new Error('分析进行中，请等待或停止后再切换论文。');}await loadPaper();}));
  $('#studyAsset').addEventListener('change',loadAsset);
  $('#studyLevel').addEventListener('change',()=>{$('#sectionField').hidden=$('#studyLevel').value!=='section';});
  $('#questionScope').addEventListener('change',()=>{const question=$('#studyQuestion').value;setMode($('#questionScope').value==='library'?'knowledge':'question');root.classList.remove('analysis-collapsed');$('#studyQuestion').value=question;});
  $('#startStudy').addEventListener('click',start);
  $('#stopStudy').addEventListener('click',protect(async()=>{if(S.active){await api('/api/study/cancel',{id:S.active});$('#taskStatus').textContent='正在停止…';}}));
  $('#studyTopic').addEventListener('change',renderResearch);
  $('#createTopic').addEventListener('click',protect(async()=>{const topic=await api('/api/research/topic',{title:$('#topicTitle').value,question:$('#topicQuestion').value});S.topic=topic.id;await loadResearch();$('#topicTitle').value='';$('#topicQuestion').value='';$('.new-topic').open=false;root.classList.remove('topic-create-open');notify('研究主题已创建。');}));
  $('#cancelTopic').addEventListener('click',()=>{$('.new-topic').open=false;root.classList.remove('topic-create-open');const collection=$('.knowledge-collection')||$('.reader-collection');collection.open=false;});
  $('#collectNotes').addEventListener('click',protect(async()=>{const r=await api('/api/research/collect',{paper:$('#studyPaper').value,topic:S.topic});await loadResearch();notify('已收集 '+r.added+' 条记录，已有记录不会重复添加。');}));
  $('#addRecord').addEventListener('click',protect(async()=>{await api('/api/research/record',{topic:S.topic,text:$('#recordText').value,kind:$('#recordKind').value,paper:$('#studyPaper').value});$('#recordText').value='';await loadResearch();notify('记录已保存并关联当前论文。');}));
  $('#studyResult').addEventListener('click',protect(async e=>{
    if(e.target.closest('[data-focus-followup]')){$('#followupQuestion').scrollIntoView({block:'center'});$('#followupQuestion').focus();return;}
    if(e.target.closest('[data-edit-run]')){root.classList.remove('analysis-collapsed');$('#analysisForm').scrollIntoView({block:'start'});$('#studyQuestion').focus();return;}
    if(e.target.closest('[data-send-followup]')){const question=$('#followupQuestion').value.trim();if(!question){$('#followupQuestion').focus();return;}$('#studyQuestion').value=question;await start();return;}
    const section=e.target.closest('[data-section-read]');if(section){setMode('overview');root.classList.remove('analysis-collapsed');$('#studyLevel').value='section';$('#sectionField').hidden=false;$('#studySection').value=section.dataset.sectionRead;const showForm=options.onSection?options.onSection(S.meta.sections.find(s=>s.id===section.dataset.sectionRead)):true;if(showForm!==false)$('#analysisForm').scrollIntoView({block:'start'});}
    const pin=e.target.closest('[data-pin]');if(pin){if(!S.topic){const collection=$('.knowledge-collection')||$('.reader-collection');collection.open=true;collection.scrollIntoView({block:'center'});$('#studyTopic').focus();notify('选择或新建一个主题，再保存这条结论。');return;}await api('/api/research/pin',{run:S.run.id,path:pin.dataset.pin,topic:S.topic});await loadResearch();notify('已保存到研究主题，来源引文一并保留。');pin.textContent='已保存到主题';}
    const follow=e.target.closest('[data-follow]');if(follow){const composer=$('#followupQuestion');if(composer){composer.value=follow.dataset.follow;composer.scrollIntoView({block:'center'});composer.focus();}else{setMode(S.run&&S.run.mode==='knowledge'?'knowledge':'question');root.classList.remove('analysis-collapsed');$('#studyQuestion').value=follow.dataset.follow;$('#studyQuestion').focus();}}
  }));
  function routeRun(run){if(!embedded && !['compare','knowledge'].includes(run.mode)){location.href='/read/'+encodeURIComponent(run.papers[0])+'?tool='+(run.mode==='section'?'overview':run.mode)+'&analysis='+encodeURIComponent(run.id);return true;}if(embedded && (!(run.papers||[]).includes(options.paper)||run.mode==='compare')){location.href='/study?mode='+(run.mode==='knowledge'?'knowledge':'compare')+'&run='+encodeURIComponent(run.id);return true;}return false;}
  $('#studyHistory').addEventListener('click',protect(async e=>{const b=e.target.closest('[data-history]');if(!b)return;if(S.active&&S.active!==b.dataset.history)throw new Error('当前分析尚在进行，请等待或停止后切换。');clearTimeout(S.poll);const run=await api('/api/study/run?id='+encodeURIComponent(b.dataset.history));if(routeRun(run))return;restoreForm(run);await poll(b.dataset.history);$('.analysis-options').open=false;if(embedded||innerWidth<=1000)$('.history-disclosure').open=false;if(!embedded)$('#studyResult').scrollIntoView({block:'start'});}));
  $('#newStudy').addEventListener('click',async()=>{await ready;if(S.active){notify('分析仍在进行，请等待完成或先停止。');return;}S.run=null;$('#studyResult').innerHTML='';$('#studyQuestion').value='';$('#taskStatus').textContent='';$('#studyNotice').hidden=true;root.classList.remove('analysis-collapsed');updateUrl(runKey,'');renderHistory();if(embedded||innerWidth<=1000)$('.history-disclosure').open=false;$('#studyQuestion').focus();});
  $('#studyTopics').addEventListener('click',e=>{const button=e.target.closest('[data-topic]');if(button){$('#studyTopic').value=button.dataset.topic;renderResearch();}});
  $('#recordFilters').addEventListener('click',e=>{const b=e.target.closest('[data-record-filter]');if(b){S.recordFilter=b.dataset.recordFilter;renderResearch();}});
  $('#researchRecords').addEventListener('input',e=>{if(e.target.matches('[data-comment]'))S.comments[e.target.closest('[data-record]').dataset.record]=e.target.value;});
  $('#researchRecords').addEventListener('click',protect(async e=>{
    const save=e.target.closest('[data-record-save]'),status=e.target.closest('[data-record-status]');if(!save&&!status)return;
    const id=(save||status).dataset[save?'recordSave':'recordStatus'],record=S.research.records.find(r=>r.id===id);
    const body={id,topic:record.topic,text:record.text,kind:record.kind,comment:e.target.closest('[data-record]').querySelector('[data-comment]').value,status:status?(record.status==='done'?'open':'done'):record.status};
    await api('/api/research/record',body);delete S.comments[id];await loadResearch();notify('研究记录已更新。');
  }));
  $('#zoteroSearch').addEventListener('click',protect(async()=>{const r=await api('/api/zotero/search?q='+encodeURIComponent($('#zoteroQuery').value));$('#zoteroMatches').innerHTML=r.available?(r.items.map(i=>'<div class="zotero-row">'+esc(i.title)+' · '+esc(i.date)+' <button class="btn sm line" data-zotero="'+esc(i.key)+'">关联</button></div>').join('')||'<p>没有匹配条目，试试 DOI 或更短的标题。</p>'):'<p class="hint">'+esc(r.message)+'</p>';}));
  $('#zoteroMatches').addEventListener('click',protect(async e=>{const b=e.target.closest('[data-zotero]');if(b){S.meta.zotero=await api('/api/zotero/link',{paper:S.meta.id,key:b.dataset.zotero});renderZoteroLink();notify('已保存 Zotero 对应关系。');}}));
  let dragStart=null;
  const stage=$('#cropStage');
  function point(e){const r=stage.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];}
  function drawCrop(crop){const b=$('#cropBox');b.hidden=false;b.style.left=crop[0]*100+'%';b.style.top=crop[1]*100+'%';b.style.width=(crop[2]-crop[0])*100+'%';b.style.height=(crop[3]-crop[1])*100+'%';}
  stage.addEventListener('pointerdown',e=>{dragStart=point(e);stage.setPointerCapture(e.pointerId);});
  stage.addEventListener('pointermove',e=>{if(dragStart){const end=point(e);drawCrop([Math.min(dragStart[0],end[0]),Math.min(dragStart[1],end[1]),Math.max(dragStart[0],end[0]),Math.max(dragStart[1],end[1])]);}});
  stage.addEventListener('pointerup',e=>{if(!dragStart)return;const end=point(e);S.crop=[Math.min(dragStart[0],end[0]),Math.min(dragStart[1],end[1]),Math.max(dragStart[0],end[0]),Math.max(dragStart[1],end[1])];dragStart=null;if(S.crop[2]-S.crop[0]<.01||S.crop[3]-S.crop[1]<.01)S.crop=null;$('#cropBox').hidden=!S.crop;$('#clearCrop').hidden=!S.crop;if(S.crop)$('#imageHint').textContent='已框选区域。分析时会发送此区域，并保留题注与正文上下文。';});
  stage.addEventListener('pointercancel',()=>{dragStart=null;S.crop=null;$('#cropBox').hidden=true;$('#clearCrop').hidden=true;});
  $('#clearCrop').addEventListener('click',loadAsset);
  async function init(){
    try{
      const lib=await api('/api/library');PR.token=lib.token;S.papers=lib.items;
      if(PR.refreshNavigation)PR.refreshNavigation(lib.items);
      $('#studyPaper').innerHTML=S.papers.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.title_zh||p.title_en||p.id)+'</option>').join('');
      const initialPaper=options.paper||params.get('paper')||PR.ls.get('easyread-current-reading','');if(S.papers.some(p=>p.id===initialPaper))$('#studyPaper').value=initialPaper;
      $('#comparePapers').innerHTML=S.papers.map(p=>'<label><input type="checkbox" data-compare value="'+esc(p.id)+'">'+esc(p.title_zh||p.title_en||p.id)+'</label>').join('');
      const categories=Array.from(new Set(S.papers.flatMap(p=>p.tags||[]))).sort();$('#knowledgeCategory').innerHTML='<option value="">全部收藏文章 · '+S.papers.length+' 篇</option>'+categories.map(c=>'<option value="'+esc(c)+'">'+esc(c)+' · '+S.papers.filter(p=>(p.tags||[]).includes(c)).length+' 篇</option>').join('');
      const models=await api('/api/chat/models');$('#studyModel').innerHTML=models.models.map(m=>'<option value="'+esc(m.id)+'"'+(m.ready?'':' disabled')+'>'+esc(m.label+(m.detail?' · '+m.detail:''))+'</option>').join('');$('#studyModel').value=models.default;
      await loadResearch();await loadPaper();setMode(params.get(modeKey)||(embedded?'question':'research'));
      if(S.mode==='research'&&!S.topic&&S.research.topics.length){$('#studyTopic').value=S.research.topics[0].id;renderResearch();}
      if(params.get(runKey)){const run=await api('/api/study/run?id='+encodeURIComponent(params.get(runKey)));if(routeRun(run))return;if(params.get(modeKey)!=='research')restoreForm(run);await poll(params.get(runKey));}
    }catch(e){notify('无法加载分析工具：'+e.message,true);$('#startStudy').disabled=true;}
  }
  root.addEventListener('click',e=>{
    const claim=e.target.closest('.claim');if(claim){$$('.claim.selected').forEach(n=>n.classList.remove('selected'));claim.classList.add('selected');}
    if(e.target.closest('[data-new-topic]')){root.classList.add('topic-create-open');const collection=$('.knowledge-collection')||$('.reader-collection');collection.open=true;$('.new-topic').open=true;$('#topicTitle').scrollIntoView({block:'center'});$('#topicTitle').focus();}
    const source=e.target.closest('a[data-source]');
    if(source && options.onSource && !e.ctrlKey && !e.metaKey){if(options.onSource(source.href))e.preventDefault();}
  });
  const modelSummary=$('.analysis-options > summary');modelSummary.innerHTML=PR.icon('gear');modelSummary.title='选择本次分析模型';modelSummary.setAttribute('aria-label','模型设置');
  if(embedded){
    const toolbar=document.createElement('div');toolbar.className='reader-study-toolbar';$('#modeTitle').before(toolbar);toolbar.append($('#modeTitle'),$('.analysis-options'));
    $('.history-disclosure').open=false;$('#studyResult').after($('.history-disclosure'));$('.study-sidebar').hidden=true;$('.study-context').hidden=true;
    $('#studyQuestion').closest('label').after($('#questionScopeControls'));
    const collection=document.createElement('details');collection.className='reader-collection';collection.innerHTML='<summary>选择研究主题</summary>';
    const picker=$('.topic-picker');$('.history-disclosure').after(collection);collection.append(picker);
  }else{
    $('.workspace-heading').append($('.analysis-options'));
    $('.history-disclosure').open=innerWidth>1000;
    const collection=document.createElement('details');collection.className='knowledge-collection';collection.innerHTML='<summary>保存到研究主题（可选）</summary>';const picker=$('.topic-picker');$('#studyResult').after(collection);collection.append(picker);
  }
  if(!embedded){
    const historyLayout=matchMedia('(min-width:1001px)');
    historyLayout.addEventListener('change',e=>{$('.history-disclosure').open=e.matches;});
    $('.history-disclosure > summary').addEventListener('click',e=>{if(historyLayout.matches)e.preventDefault();});
  }
  const edit=document.createElement('button');edit.className='edit-analysis';edit.textContent='修改问题 / 重新分析';edit.onclick=()=>{root.classList.remove('analysis-collapsed');$('#studyQuestion').focus();};$('#modeTitle').after(edit);
  $('#studyQuestion').disabled=true;
  const ready=init().finally(()=>{$('#studyQuestion').disabled=false;});
  return {
    ready,
    async open(mode, args={}){
      await ready;
      if(S.active && mode!==S.mode){notify('分析仍在进行，可等待完成或先停止。');return;}
      setMode(mode);
      if(args.asset){if($('#studyAsset').value!==args.asset){S.run=null;$('#studyResult').innerHTML='';updateUrl(runKey,'');}root.classList.remove('analysis-collapsed');$('#studyAsset').value=args.asset;loadAsset();updateUrl('asset',args.asset);}
      if(args.section){$('#studyLevel').value='section';$('#sectionField').hidden=false;$('#studySection').value=args.section;}
      if(args.question!==undefined)$('#studyQuestion').value=args.question;
    }
  };
  };
})(window.PR);
