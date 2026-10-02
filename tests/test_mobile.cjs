'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const C=require('../easyread/web/mobile/core.js');
const base={id:'n-1',anchor:'intro',key:'intro',body:'初稿',quote:'文字',updated:'2026-10-02T09:00:00+08:00'};
const reader={...C.emptyReader(),notes:{'n-1':base}};
const a=C.cloudOp(reader,{op:'note',note:{...base,body:'手机修改',updated:'2026-10-02T01:10:00Z'}},'a');
const b=C.cloudOp(reader,{op:'note',note:{...base,body:'电脑修改',updated:'2026-10-02T09:20:00+08:00'}},'b');
let merged=C.materialize([reader],[a,b,a]);
assert.equal(merged.notes['n-1'].body,'电脑修改');
assert.equal(merged.notes['n-1']._syncConflicts[0].body,'手机修改');
assert.deepEqual(C.materialize([reader],[b,a]).notes,merged.notes);
const sequential=C.cloudOp(C.applyOps(reader,[a]),{op:'note',note:{...base,body:'继续修改',updated:'2026-10-02T01:30:00Z'}},'c');
assert.equal(C.materialize([reader],[sequential,a]).notes['n-1']._syncConflicts,undefined);
const del=C.cloudOp(reader,{op:'note_del',id:'n-1',at:'2026-10-02T01:25:00Z'},'del');
assert.equal(C.materialize([reader],[del]).notes['n-1']._syncConflicts,undefined);
const dc=C.materialize([reader],[del,a]);
assert.equal(dc.notes['n-1'].deleted,true);assert.equal(dc.notes['n-1']._syncConflicts[0].body,'手机修改');
const resolved={...merged.notes['n-1'],updated:'2026-10-02T01:40:00Z'};delete resolved._syncConflicts;
const event=C.cloudOp(merged,{op:'note',note:resolved,resolve_conflicts:true},'resolve');
assert.equal(C.materialize([reader],[event,a,b]).notes['n-1']._syncConflicts,undefined);
assert.equal(C.applyOps(reader,[a]).notes['n-1'].body,'手机修改');
assert.equal(C.applyOps(C.applyOps(reader,[b]),[a]).notes['n-1'].body,'电脑修改');
const data={paper:{meta:{source_sha256:'a'.repeat(64),title_zh:'公开测试',api_key:'secret'},blocks:[{id:'intro',type:'para',zh:'测试',config:{api_key:'secret'}}]},reader:{...reader,api_key:'secret'},config:{api_key:'secret'},chat:{api_key:'secret'},images:{evil:'https://evil.example/track',svg:'data:image/svg+xml;base64,AAAA'},item:{api_key:'secret'}};
const html='<script>throw new Error("must not execute")</script><script type="application/json" id="pr-data">'+JSON.stringify(data)+'</script>';
const normalized=C.parseImport(html);assert(!JSON.stringify(normalized).includes('secret'));assert.deepEqual(normalized.images,{});
assert.throws(()=>C.parseImport('<html>bad</html>'));assert.throws(()=>C.normalize({...data,paper:{...data.paper,blocks:[{id:'constructor'}]}}));
assert.throws(()=>C.parseImport(' '.repeat(C.MAX_BYTES+1)),/64 MB/);
assert(!JSON.stringify(C.cloudOp(reader,{op:'note',note:{...base,api_key:'secret'},api_key:'secret'},'secure')).includes('secret'));

// Exercise the actual IndexedDB wrapper with asynchronous transaction completions.
const maps={papers:new Map(),settings:new Map()};
const clone=v=>v===undefined?undefined:structuredClone(v);
const db={transaction(name){const tx={objectStore(){const map=maps[name];return {
  get(k){return req(()=>map.get(k));},getAll(){return req(()=>[...map.values()]);},put(v,k){return req(()=>{map.set(k||v.paper_id,clone(v));return k||v.paper_id;});}
};}};function req(fn){const r={};queueMicrotask(()=>{r.result=clone(fn());r.onsuccess?.();setTimeout(()=>tx.oncomplete?.(),0);});return r;}return tx;}};
const indexedDB={open(){const r={};queueMicrotask(()=>{r.result=db;r.onsuccess();});return r;}};
const window={FolioMobile:C};vm.runInNewContext(fs.readFileSync('easyread/web/mobile/storage.js','utf8'),{window,indexedDB,crypto,Promise});
(async()=>{
  const S=window.FolioStorage;await S.save({...normalized,pending:[]});
  const first=await S.commit(normalized.paper_id,[a]);
  const sent=new Set(first.pending.map(e=>e.event_id));
  // The user edits during an in-flight upload; only acknowledged events leave the outbox.
  const editing=S.commit(normalized.paper_id,[{op:'note',note:{...base,body:'上传期间的新修改',updated:'2026-10-02T02:00:00Z'}}]);
  const merging=S.mergeRemote(normalized.paper_id,C.materialize([reader],first.pending),sent,{bound_account:'acct'});
  await editing;const result=await merging;
  assert.equal(result.pending.length,1);assert.equal(result.reader.notes['n-1'].body,'上传期间的新修改');
  assert.equal(result.reader.notes['n-1']._syncConflicts,undefined);
  console.log('Mobile protocol, privacy, conflicts, timezone, and in-flight edits: passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
