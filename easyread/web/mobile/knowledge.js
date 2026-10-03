/* 共同云端资料的检索：缓存索引，引用保留论文、段落和原文页。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.FolioKnowledge=factory();})(typeof window==='object'?window:this,function(){
  'use strict';
  const STOP=new Set('the and that this with from have which what about for are how can could should 我们 什么 如何 哪些 是否 论文 资料 知识 相关'.split(' '));
  function terms(text) {
    const words=String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]{1,}|[\u4e00-\u9fff]+/g) || [];
    return [...new Set(words.flatMap(w=>/[\u4e00-\u9fff]/.test(w)?[w,...Array.from({length:Math.max(0,w.length-1)},(_,i)=>w.slice(i,i+2))]:[w]).filter(w=>!STOP.has(w)))];
  }
  const plain=value=>String(value || '').replace(/<[^>]+>/g,' ').replace(/[#$*_`]/g,'').replace(/\s+/g,' ').trim();
  function passages(data,includeNotes=true) {
    const meta={...data.paper.meta,...data.item?.meta_override},title=meta.title_zh || meta.title_en || '未命名论文',out=[];
    for(const block of data.paper.blocks || []) {
      if(block.type==='references')continue;
      const edit=data.reader?.edits?.[block.id],text=plain((edit&&!edit.reverted?edit.zh:block.zh || '')+'\n'+(block.en || '')+'\n'+(block.caption_zh || block.caption_en || '')+'\n'+(block.items || []).map(i=>i.zh || i.en).join('\n')+'\n'+(block.rows || []).map(r=>r.join(' ')).join('\n'));
      for(let start=0;start<text.length;start+=1300) {const excerpt=text.slice(start,start+1500);if(excerpt.length>=25)out.push({paper_id:data.paper_id,title,block:block.id,page:block.page || null,type:'text',text:excerpt});}
    }
    if(includeNotes)for(const note of Object.values(data.reader?.notes || {}))if(!note.deleted&&note.body)out.push({paper_id:data.paper_id,title,block:note.anchor,page:data.paper.blocks.find(b=>b.id===note.anchor)?.page || null,type:'note',text:plain((note.quote || '')+'\n'+note.body)});
    if(includeNotes&&data.reader?.paper_note?.body)out.push({paper_id:data.paper_id,title,block:'head',page:null,type:'note',text:plain(data.reader.paper_note.body)});
    return out;
  }
  function retrieve(corpus,query,includeNotes=true) {
    const tokens=terms(query),all=corpus.flatMap(data=>passages(data,includeNotes)),frequencies=new Map();
    for(const source of all)for(const token of tokens)if(source.text.toLowerCase().includes(token))frequencies.set(token,(frequencies.get(token)||0)+1);
    const ranked=all.map(source=>{
      const text=source.text.toLowerCase(),title=source.title.toLowerCase();
      const score=tokens.reduce((sum,t)=>sum+(text.includes(t)?Math.log(1+all.length/(1+(frequencies.get(t)||0))):0)+(title.includes(t)?1.5:0),0);
      return {...source,score};
    }).filter(s=>s.score>0).sort((a,b)=>b.score-a.score || a.paper_id.localeCompare(b.paper_id));
    const selected=[],counts=new Map();
    for(const source of ranked) {if((counts.get(source.paper_id)||0)>=4)continue;selected.push({...source,id:'S'+(selected.length+1)});counts.set(source.paper_id,(counts.get(source.paper_id)||0)+1);if(selected.length===12)break;}
    return {sources:selected,papers:corpus.length,passages:all.length,matched_papers:new Set(ranked.map(x=>x.paper_id)).size};
  }
  return {terms,passages,retrieve};
});
