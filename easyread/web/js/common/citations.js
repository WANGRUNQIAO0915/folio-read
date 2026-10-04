/* Match only citations supported by this paper's extracted bibliography. */
(function(root){
  'use strict';
  const norm=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
  const tokens=s=>norm(s).match(/[\p{L}][\p{L}'’\-]+/gu)||[];
  const indexes=new WeakMap();
  function index(references){if(indexes.has(references))return indexes.get(references);const entries=(references||[]).map(r=>{
    const text=String(r.text||''),year=text.match(/\b(?:19|20)\d{2}[a-z]?\b/i);
    const head=year?text.slice(0,year.index):'';
    // Keep first-author name tokens; accept surname-first and given-name-first formats.
    const first=head.replace(/^\s*\[?\d+\]?[.\s]*/,'').split(/,|\s+and\s+|\s*&\s*/i)[0];
    return {ref:r,year:year?.[0].toLowerCase(),authors:tokens(first)};
  });if(references)indexes.set(references,entries);return entries;}
  function authorIds(label,entries){
    const year=label.match(/\b((?:19|20)\d{2}[a-z]?)\b/i);if(!year)return [];
    const author=label.slice(0,year.index).replace(/et\s+al\.?|等(?:人)?/gi,'').replace(/[,，(（\s]+$/,'');
    const parts=author.split(/\s+(?:and|和|与)\s+|\s*[&＆、]\s*/i);
    const words=tokens(parts[0]);const surname=words[words.length-1];if(!surname)return [];
    return entries.filter(x=>x.year===year[1].toLowerCase()&&x.authors.includes(surname)).map(x=>String(x.ref.id));
  }
  function numericIds(inner,refs){
    const out=[];for(const part of inner.split(/[,，;；]/)){
      const range=part.trim().split(/\s*[–—−-]\s*/).map(Number);if(range.length>2||range.some(n=>!Number.isInteger(n)||n<1))return [];
      const end=range[1]??range[0];if(end<range[0]||end-range[0]>60)return [];
      for(let n=range[0];n<=end;n++){if(!refs.has(String(n)))return [];out.push(String(n));}
    }return [...new Set(out)];
  }
  function link(text,references,keep,esc){
    const entries=index(references),refs=new Set(entries.map(x=>String(x.ref.id)));
    const anchor=(label,ids,ambiguous=false)=>ids.length?keep('<a class="cite" href="#ref-'+esc(ids[0])+'" data-ref="'+esc(ids[0])+'" data-refs="'+esc(ids.join('|'))+'"'+(ambiguous?' data-cite-ambiguous="true"':'')+' title="预览参考文献">'+esc(label)+'</a>'):label;
    text=text.replace(/[\[［【](\d+(?:\s*[,，;；–—−-]\s*\d+)*)[\]］】]/g,(m,inner)=>anchor(m,numericIds(inner,refs)));
    // Parenthetical multi-citations keep punctuation and resolve each author-year entry.
    text=text.replace(/[(（]([^()（）\n]{2,200})[)）]/g,(m,inner)=>{
      if(!/\b(?:19|20)\d{2}[a-z]?\b/i.test(inner))return m;
      const linked=inner.split(/([;；])/).map(p=>{const ids=authorIds(p,entries);return anchor(p,ids,ids.length>1);}).join('');
      return m[0]+linked+m.slice(-1);
    });
    // Narrative: Smith et al. (2023), Smith & Jones (2023), Smith（2023）.
    return text.replace(/([\p{L}][\p{L}'’\-]+(?:\s+(?:et\s+al\.?|等人?)|\s*(?:&|and|和|与)\s*[\p{L}][\p{L}'’\-]+)?)\s*[(（]((?:19|20)\d{2}[a-z]?)[)）]/gu,(m)=>{const ids=authorIds(m,entries);return anchor(m,ids,ids.length>1);});
  }
  const api={index,authorIds,numericIds,link};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FolioCitations=api;
})(typeof window==='undefined'?{}:window);
