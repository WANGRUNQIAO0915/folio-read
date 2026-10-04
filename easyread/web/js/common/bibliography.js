/* Standard CSL bibliography; independent of in-text reader citation matching. */
(function(root){
  'use strict';
  const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tex=s=>String(s||'').replace(/[\\{}%&#_$~^]/g,c=>({'\\':'\\textbackslash{}','{':'\\{','}':'\\}','%':'\\%','&':'\\&','#':'\\#','_':'\\_','$':'\\$','~':'\\textasciitilde{}','^':'\\textasciicircum{}'}[c]));
  function bibtex(item){
    const year=item.issued?.['date-parts']?.[0]?.[0];
    const first=item.author?.[0],key=((first?.family||first?.literal||'anon').replace(/[^A-Za-z]/g,'').toLowerCase()||'anon')+(year||'')+((item.title||'paper').match(/[A-Za-z]{4,}/)?.[0]||'paper').toLowerCase();
    const fields={title:tex(item.title),author:(item.author||[]).map(n=>n.literal?'{'+tex(n.literal)+'}':tex([n['non-dropping-particle'],n.family].filter(Boolean).join(' '))+(n.suffix?', '+tex(n.suffix):'')+(n.given?', '+tex(n.given):'')).join(' and '),year,
      journal:tex(item['container-title']),volume:tex(item.volume),number:tex(item.issue),pages:tex(item.page).replace(/(\d)[–-](\d)/g,'$1--$2'),doi:tex(item.DOI),url:tex(item.URL)};
    if(item.number&&!item.page)fields.eid=tex(item.number);
    if(item.archive==='arXiv'){fields.eprint=tex(item.archive_location);fields.archivePrefix='arXiv';}
    if(item.type==='paper-conference'){fields.booktitle=fields.journal;delete fields.journal;}
    const type=item.type==='article-journal'?'article':item.type==='paper-conference'?'inproceedings':item.type==='book'?'book':'misc';
    return '@'+type+'{'+key+',\n'+Object.entries(fields).filter(([,v])=>v).map(([k,v])=>'  '+k+' = {'+v+'}').join(',\n')+'\n}';
  }
  function format(item,style,assets,Engine=root.CSL){
    if(style==='bibtex'){const text=bibtex(item);return {text,html:'<pre>'+esc(text)+'</pre>'};}
    if(!['apa','gb'].includes(style))throw new Error('不支持的引用格式');
    const source=style==='gb'&&item.number&&!item.page?{...item,page:item.number}:item;
    const engine=new Engine.Engine({retrieveLocale:lang=>assets[lang==='zh-CN'?'zh':'en'],retrieveItem:()=>source},assets[style],style==='gb'?'zh-CN':'en-US');
    engine.updateItems([item.id]);
    const html=engine.makeBibliography()[1].join('').trim();
    engine.setOutputFormat('text');
    const text=engine.makeBibliography()[1].join('').trim();
    return {text,html};
  }
  const api={format,bibtex};root.FolioBibliography=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
