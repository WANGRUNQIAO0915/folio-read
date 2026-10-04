/* Portable reading data. Only document data is included in cloud packages. */
(function (root) {
  'use strict';
  const O=root.FolioOrganization || (typeof require==='function'?require('../js/common/organization.js'):null);
  const MAX_BYTES = 64 * 1024 * 1024;
  const copy = value => JSON.parse(JSON.stringify(value));
  const safeKey = key => typeof key === 'string' && key.length > 0 && key.length < 200 && !['__proto__','prototype','constructor'].includes(key);
  const esc = text => String(text == null ? '' : text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time = value => Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : 0;
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => safeKey(k) && !k.startsWith('_sync')).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function emptyReader() { return {schema:2,rev:0,edits:{},notes:{},paper_note:{},progress:{}}; }
  const FIELDS = {
    meta:'title_zh title_en short_zh authors affiliation year date venue arxiv url doi page_count source_sha256 abstract_en source pages pdf text_status extraction_note',
    block:'id type level num appendix zh en page role ordered items tex tag src caption_zh caption_en head rows source_links',
    note:'id anchor key quote prefix suffix segments lang root_index kind color style body created updated deleted _syncConflicts',
    segment:'anchor key quote prefix suffix lang root_index',
    edit:'zh base at reverted prev',
    item:'tags status starred rating meta_override added updated last_opened archived status_manual naming',
    link:'url label page rect',
    reference:'id text url doi',
    entry:'id anchor quote kind title q body at updated reply_to',
    translation:'done_pages note',
    naming:'title source original_title original_filename updated version'
  };
  const NAMING_SOURCES=new Set(['existing_chinese','bibliographic_metadata','pdf_metadata','first_page_title','filename','ai_translation','manual']);
  const namingLabels={existing_chinese:'已有中文标题',bibliographic_metadata:'书目元数据',pdf_metadata:'PDF 元数据',first_page_title:'首页标题',filename:'原文件名',ai_translation:'AI 译名（非官方中文题名）',manual:'手动名称'};
  const hasChinese=value=>/[\u3400-\u9fff\u{20000}-\u{3134f}]/u.test(value || '');
  const namingWhitespace=/[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
  const namingPdfSuffix=new RegExp('(?:\\.pdf'+namingWhitespace.source.replace(/\+$/,'*')+')+$','i');
  const hasUnpairedSurrogate=value=>[...value].some(c=>c.length===1&&/[\ud800-\udfff]/.test(c));
  function namingTimestamp(value){
    if(typeof value!=='string')return false;
    const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
    if(!m)return false;const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
    return year>0&&month>=1&&month<=12&&day>=1&&day<=days[month-1]&&Number(m[4])<24&&Number(m[5])<60&&Number(m[6])<60&&(m[8]==='Z'||Number(m[8].slice(1,3))<24&&Number(m[8].slice(4,6))<60)&&Number.isFinite(Date.parse(value));
  }
  const namingText=value=>typeof value==='string'?value.normalize('NFC').trim():'';
  function namingTitle(value) {
    const title=namingText(value).replace(namingWhitespace,' ').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu,'').replace(/(?:\.pdf\s*)+$/i,'').trim();
    if(!title || [...title].length>200)throw new Error('名称需为 1–200 个字符。');
    return title;
  }
  function cleanNaming(value) {
    if(!value || typeof value!=='object' || Array.isArray(value))return null;
    try {
      const title=namingTitle(value.title);
      if(!NAMING_SOURCES.has(value.source) || typeof value.version!=='string' || !value.version || [...value.version].length>200 || /[\x00-\x1f\x7f]/.test(value.version))return null;
      if(!namingTimestamp(value.updated))return null;
      if(['version','original_title','original_filename'].some(k=>typeof value[k]==='string'&&hasUnpairedSurrogate(value[k])))return null;
      if(['original_title','original_filename'].some(k=>typeof value[k]!=='string' || [...value[k]].length>1000))return null;
      return {title,source:value.source,original_title:value.original_title,original_filename:value.original_filename,updated:value.updated,version:value.version};
    } catch(_){return null;}
  }
  function preferNaming(a,b) {
    const left=cleanNaming(a),right=cleanNaming(b);
    if(!left)return right;if(!right)return left;
    return time(left.updated)-time(right.updated)>0?left:time(left.updated)-time(right.updated)<0?right:left.version!==right.version?(left.version>right.version?left:right):canonical(left)>canonical(right)?left:right;
  }
  function displayTitle(data) {return cleanNaming(data.item?.naming)?.title || data.item?.meta_override?.title_zh || data.paper.meta.title_zh || data.paper.meta.title_en || '未命名论文';}
  function namingCandidate(data) {
    const existing=cleanNaming(data.item?.naming),meta=data.paper.meta,override=data.item?.meta_override || {};
    if(existing)return {title:existing.title,source:existing.source};
    for(const [value,source] of [[override.title_zh,'existing_chinese'],[meta.title_zh,'existing_chinese'],[meta.title_en,'pdf_metadata'],[meta.source?.replace?.(/\.pdf$/i,''),'filename']]) {
      if(!hasChinese(value))continue;
      try{return {title:namingTitle(value),source};}catch(_){}
    }
    return {title:'',source:'manual'};
  }
  function makeNaming(data,title,source='manual',version,updated=new Date().toISOString()) {
    const previous=cleanNaming(data.item?.naming),meta=data.paper.meta;
    const result=cleanNaming({title:namingTitle(title),source,original_title:previous?.original_title ?? [...String(meta.title_en || meta.title_zh || '')].slice(0,1000).join(''),
      original_filename:previous?.original_filename ?? [...String(meta.source || meta.pdf || '')].slice(0,1000).join(''),updated,version});
    if(!result)throw new Error('名称来源或版本无效，请重新预览。');return result;
  }
  function pdfFilename(value,suffix='') {
    let stem=String(value||'').normalize('NFC').replace(/^[. ]+|[. ]+$/g,'').replace(namingPdfSuffix,'').replace(/[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]/gu,'_').replace(namingWhitespace,' ').replace(/^[. ]+|[. ]+$/g,'') || '论文';
    if(/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem.split('.')[0].trim()))stem='_'+stem;
    const tail=(suffix?' ('+String(suffix).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,50)+')':'')+'.pdf';
    const limit=180-new TextEncoder().encode(tail).length;let short='',bytes=0;
    for(const char of stem){const size=new TextEncoder().encode(char).length;if(bytes+size>limit)break;short+=char;bytes+=size;}
    return (short.replace(/[.\s]+$/g,'') || '论文')+tail;
  }
  function pdfFilenames(papers) {
    const groups=new Map(),result={};
    for(const p of papers){const name=pdfFilename(displayTitle(p)),key=name.toLowerCase();const group=groups.get(key)||[];group.push({p,name});groups.set(key,group);}
    const used=new Set();
    // Reserve unique names before allocating duplicates, so a suffix cannot clobber another title.
    for(const group of groups.values())if(group.length===1){result[group[0].p.paper_id]=group[0].name;used.add(group[0].name.toLowerCase());}
    for(const {p} of [...groups.values()].filter(group=>group.length>1).flat().sort((a,b)=>a.p.paper_id<b.p.paper_id?-1:a.p.paper_id>b.p.paper_id?1:0)){
      const suffix=String(p.paper_id).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,12)||'paper';let name=pdfFilename(displayTitle(p),suffix),n=2;
      while(used.has(name.toLowerCase()))name=pdfFilename(displayTitle(p),suffix+'-'+n++);
      result[p.paper_id]=name;used.add(name.toLowerCase());
    }
    return result;
  }
  function pick(value,kind) {
    const out={};
    for(const k of FIELDS[kind].split(' ')) if(value && Object.hasOwn(value,k)) out[k]=copy(value[k]);
    return out;
  }
  function cleanNote(value) {
    const out=pick(value,'note');
    if(Array.isArray(out.segments)) out.segments=out.segments.map(s=>pick(s,'segment'));
    if(Array.isArray(out._syncConflicts)) out._syncConflicts=out._syncConflicts.map(n=>{const v=pick(n,'note');delete v._syncConflicts;return v;});
    return out;
  }
  function cleanReader(value={}) {
    const out=emptyReader();
    out.notes=Object.fromEntries(Object.entries(value.notes || {}).filter(([id,n])=>safeKey(id)&&n&&n.id===id).map(([id,n])=>[id,cleanNote(n)]));
    out.edits=Object.fromEntries(Object.entries(value.edits || {}).filter(([id])=>safeKey(id)).map(([id,e])=>[id,pick(e,'edit')]));
    out.progress={block:value.progress?.block || null,ratio:Math.max(0,Math.min(1,Number(value.progress?.ratio)||0)),at:value.progress?.at || ''};
    out.paper_note={body:value.paper_note?.body || '',at:value.paper_note?.at || ''};
    return out;
  }
  function normalize(input) {
    if (!input || !input.paper || !Array.isArray(input.paper.blocks) || !input.paper.meta) throw new Error('这不是 Folio Read 的离线论文。请从电脑版导出离线阅读文件。');
    const hash = input.paper.meta.source_sha256;
    const id = /^[a-f0-9]{64}$/i.test(hash || '') ? hash.toLowerCase() : input.paper_id;
    if (!safeKey(id)) throw new Error('论文缺少可用于同步的标识，请重新导出。');
    const ids = new Set();
    for (const block of input.paper.blocks) {
      if (!block || !safeKey(block.id) || ids.has(block.id)) throw new Error('论文段落标识无效或重复。');
      ids.add(block.id);
    }
    const images = {};
    for (const [key,value] of Object.entries(input.images || {})) {
      if (safeKey(key) && typeof value === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\s]+$/.test(value)) images[key] = value;
    }
    const meta=pick(input.paper.meta,'meta');
    const journal=root.FolioJournal || (typeof require==='function'?require('../js/common/journal-rank.js'):null);
    const rank=journal?.clean(input.paper.meta.journal_rank);if(rank)meta.journal_rank=rank;
    if(Array.isArray(meta.pages)) meta.pages=meta.pages.map(p=>({n:p.n,img:p.img}));
    const blocks=input.paper.blocks.map(b=>{const out=pick(b,'block');
      if(Array.isArray(out.items)) out.items=out.items.map(i=>({zh:i.zh || '',en:i.en || ''}));
      if(Array.isArray(out.source_links)) out.source_links=out.source_links.map(l=>pick(l,'link'));return out;});
    const paper={schema:2,meta,blocks,references:(input.paper.references || []).map(r=>pick(r,'reference'))};
    if(input.paper.translation && typeof input.paper.translation==='object') {
      paper.translation=pick(input.paper.translation,'translation');
      paper.translation.done_pages=[...new Set((input.paper.translation.done_pages || []).filter(p=>Number.isInteger(p)&&p>0&&p<=10000))].sort((a,b)=>a-b);
    }
    const item=pick(input.item,'item');const naming=cleanNaming(item.naming);if(naming)item.naming=naming;else delete item.naming;if(item.meta_override) item.meta_override=pick(item.meta_override,'meta');
    if(input.organization&&O){const org=O.normalize(input.organization);if(org.assignments[id])item.tags=O.assignment(org,id).tags;}
    return {schema:1,kind:'folio-mobile-paper',paper_id:id,paper,reader:cleanReader(input.reader || {}),
      discussion:{entries:(input.discussion?.entries || []).map(e=>pick(e,'entry'))},item,images,
      imported_at:input.imported_at || new Date().toISOString(),...(input.organization&&O?{organization:O.exportSubset(input.organization,[id])}:{})};
  }
  function parseImport(text) {
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('这篇离线论文超过 64 MB，请先导出较小的阅读文件。');
    let payload = text;
    if (!text.trim().startsWith('{')) {
      const match = text.match(/<script\b(?=[^>]*\bid=["']pr-data["'])[^>]*>([\s\S]*?)<\/script\s*>/i);
      if (!match) throw new Error('未找到离线论文数据。请导入电脑版导出的 HTML 或手机阅读 JSON 文件。');
      payload = match[1];
    }
    let data;
    try { data = JSON.parse(payload); } catch (_) { throw new Error('阅读文件损坏或格式不完整。'); }
    return normalize(data);
  }
  const newest = (a,b) => time(a.updated || a.at || a.created) - time(b.updated || b.at || b.created) || (canonical(a)<canonical(b)?-1:canonical(a)>canonical(b)?1:0);
  function applyOps(reader, ops) {
    const out = {...emptyReader(),...copy(reader || {})};
    for (const op of ops) {
      if (op.op === 'note' && op.note && safeKey(op.note.id)) {
        const prev = out.notes[op.note.id];
        if (!prev || newest(op.note,prev) >= 0) out.notes[op.note.id] = copy(op.note);
      } else if (op.op === 'note_del' && safeKey(op.id)) {
        const prev = out.notes[op.id] || {id:op.id};
        if (time(op.at) >= time(prev.updated)) out.notes[op.id] = {...prev,deleted:true,updated:op.at};
      } else if (op.op === 'progress' && time(op.at) >= time(out.progress.at)) {
        out.progress = {block:op.block,ratio:Math.max(0,Math.min(1,Number(op.ratio)||0)),at:op.at};
      } else if (op.op === 'paper_note' && time(op.at) >= time(out.paper_note.at)) {
        out.paper_note = {body:op.body || '',at:op.at};
      } else if (op.op === 'edit' && safeKey(op.block) && time(op.at) >= time((out.edits[op.block] || {}).at)) {
        out.edits[op.block] = op.zh == null ? {reverted:true,at:op.at} : {zh:op.zh,base:op.base || '',at:op.at};
      }
    }
    return out;
  }
  function cloudOp(reader, op, id) {
    const out = {op:op.op,event_id:id};
    const fields={note:[],note_del:['id','at'],progress:['block','ratio','at'],paper_note:['body','at'],edit:['block','zh','base','at']}[op.op];
    if(!fields) throw new Error('不支持的阅读操作');
    for(const key of fields) if(Object.hasOwn(op,key)) out[key]=copy(op[key]);
    if(op.op==='note') out.note=cleanNote(op.note);
    const prior=reader.notes[op.note?.id || op.id];
    if (op.op === 'note' || op.op === 'note_del') out.base_version = prior ? canonical(cleanNote(prior)) : null;
    if(op.resolve_conflicts && prior) out.parent_versions=[canonical(cleanNote(prior)),...(prior._syncConflicts || []).map(n=>canonical(cleanNote(n)))];
    return out;
  }
  function materialize(baseReaders, events) {
    let reader = emptyReader();
    const versions = new Map(), seen = new Set();
    function add(note,parent) {
      if (!note || !safeKey(note.id)) return;
      const version = canonical(note), group = versions.get(note.id) || new Map();
      const entry = group.get(version) || {note:copy(note),parents:new Set()};
      if (parent && parent !== version) entry.parents.add(parent);
      group.set(version,entry); versions.set(note.id,group);
      for (const conflict of note._syncConflicts || []) add(conflict,null);
    }
    for (const base of baseReaders) {
      for (const note of Object.values(base.notes || {})) add(note,null);
      const ops = Object.entries(base.edits || {}).map(([block,e]) => ({op:'edit',block,...e,zh:e.reverted ? null:e.zh}));
      if (base.progress && base.progress.at) ops.push({op:'progress',...base.progress});
      if (base.paper_note && base.paper_note.at) ops.push({op:'paper_note',...base.paper_note});
      reader = applyOps(reader,ops);
    }
    for (const event of events) {
      if (!event || !event.event_id || seen.has(event.event_id)) continue;
      seen.add(event.event_id);
      if (event.op === 'note') {
        add(event.note,event.base_version);
        for(const parent of event.parent_versions || []) add(event.note,parent);
      }
      else if (event.op === 'note_del' && safeKey(event.id)) {
        let prior={};try{prior=JSON.parse(event.base_version || '{}');}catch(_){}
        const note={...prior,id:event.id,deleted:true,updated:event.at};delete note._syncConflicts;
        add(note,event.base_version);for(const parent of event.parent_versions || []) add(note,parent);
      } else reader = applyOps(reader,[event]);
    }
    for (const [id,group] of versions) {
      const superseded = new Set([...group.values()].flatMap(v => [...v.parents]));
      const tips = [...group.entries()].filter(([version]) => !superseded.has(version)).map(([,v]) => v.note).sort(newest);
      if (!tips.length) continue;
      const winner = copy(tips[tips.length - 1]); delete winner._syncConflicts;
      if (tips.length > 1) winner._syncConflicts = tips.slice(0,-1).map(n => {const result=copy(n);delete result._syncConflicts;return result;});
      reader.notes[id] = winner;
    }
    return reader;
  }
  function readerEvents(reader, device) {
    const ops = [];
    for (const note of Object.values(reader.notes || {})) {
      const op = {op:'note',note};
      ops.push({...op,event_id:device + ':' + canonical(op),base_version:null});
      for (const n of note._syncConflicts || []) ops.push({op:'note',note:n,event_id:device + ':' + canonical(n),base_version:null});
    }
    for (const [block,e] of Object.entries(reader.edits || {})) ops.push({op:'edit',block,...e,zh:e.reverted ? null:e.zh,event_id:device + ':edit:' + block + ':' + e.at});
    if (reader.progress && reader.progress.at) ops.push({op:'progress',...reader.progress,event_id:device + ':progress:' + reader.progress.at});
    if (reader.paper_note && reader.paper_note.at) ops.push({op:'paper_note',...reader.paper_note,event_id:device + ':paper-note:' + reader.paper_note.at});
    return ops;
  }
  function compact(ops) {
    let last = -1;
    ops.forEach((op,i) => {if(op.op==='progress') last=i;});
    return ops.filter((op,i) => op.op !== 'progress' || i === last);
  }
  const api = {NAMING_SOURCES,namingLabels,hasChinese,namingTitle,cleanNaming,preferNaming,displayTitle,namingCandidate,makeNaming,pdfFilename,pdfFilenames,MAX_BYTES,FIELDS,pick,cleanNote,cleanReader,copy,safeKey,esc,time,canonical,emptyReader,normalize,parseImport,applyOps,cloudOp,materialize,readerEvents,compact};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {root.FolioMobile=api;root.PR={esc};}
})(typeof window === 'undefined' ? {} : window);
