/* Portable reading data. Only document data is included in cloud packages. */
(function (root) {
  'use strict';
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
    item:'tags status starred rating meta_override added updated last_opened archived status_manual',
    link:'url label page rect',
    reference:'id text url doi',
    entry:'id anchor quote kind title q body at updated reply_to',
    translation:'done_pages note'
  };
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
    const item=pick(input.item,'item');if(item.meta_override) item.meta_override=pick(item.meta_override,'meta');
    return {schema:1,kind:'folio-mobile-paper',paper_id:id,paper,reader:cleanReader(input.reader || {}),
      discussion:{entries:(input.discussion?.entries || []).map(e=>pick(e,'entry'))},item,images,
      imported_at:input.imported_at || new Date().toISOString()};
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
  const api = {MAX_BYTES,FIELDS,pick,cleanNote,cleanReader,copy,safeKey,esc,time,canonical,emptyReader,normalize,parseImport,applyOps,cloudOp,materialize,readerEvents,compact};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {root.FolioMobile=api;root.PR={esc};}
})(typeof window === 'undefined' ? {} : window);
