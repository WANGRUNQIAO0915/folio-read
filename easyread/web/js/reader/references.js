(function(PR){
  'use strict';
  let ids=[],origin=null,label='',ambiguous=false;
  const panel=()=>PR.$('#refpanel');
  PR.openReferences=function(anchor){
    ids=(anchor.dataset.refs||anchor.dataset.ref||'').split('|').filter(id=>PR.refById[id]);
    if(!ids.length){PR.toast('这条引用尚未解析出参考文献信息');return;}
    origin=anchor;label=anchor.textContent;ambiguous=!!anchor.dataset.citeAmbiguous;
    render();PR.openSide('refs');panel().querySelector('h3').focus({preventScroll:true});
  };
  function render(){
    const refs=ids.map(id=>PR.refById[id]).filter(Boolean);
    panel().innerHTML='<div class="reference-preview"><h3 tabindex="-1">参考文献 <span>'+PR.esc(label)+'</span></h3><p class="hint">'+(ambiguous?'同作者同年份有多个候选，请核对条目。':'来自本篇论文的参考文献列表。')+'</p>'+refs.map(r=>{
      const doi=PR.safeLink(r.doi)||PR.safeLink((String(r.text||'').match(/\b10\.\d{4,9}\/[^\s<>]+/)||[])[0]?.replace(/[.,;)]+$/,''));
      const url=PR.safeLink(r.url);
      return '<section class="reference-entry"><span class="reference-number">['+PR.esc(r.id)+']</span><p>'+PR.md(r.text,{cite:false,xref:false})+'</p><div class="actions"><button class="btn sm" data-ref-jump="'+PR.esc(r.id)+'">跳到文末</button><button class="btn sm" data-ref-copy="'+PR.esc(r.id)+'">复制条目</button>'+(doi?PR.externalLink('打开 DOI ↗',doi):'')+(url&&url!==doi?PR.externalLink('查看原文 ↗',url):'')+'</div></section>';
    }).join('')+'<button class="btn line" data-ref-return>返回正文</button></div>';
  }
  panel().addEventListener('click',async e=>{
    const jump=e.target.closest('[data-ref-jump]'),copy=e.target.closest('[data-ref-copy]');
    if(jump){const target='ref-'+jump.dataset.refJump;if(!document.getElementById(target))return PR.toast('文末列表尚未生成，可复制条目检索');if(innerWidth<980)PR.openSide(null);PR.jumpTo(target);}
    if(copy)await PR.copyText(PR.refById[copy.dataset.refCopy].text);
    if(e.target.closest('[data-ref-return]')){PR.openSide(null);if(origin?.isConnected){origin.focus({preventScroll:true});const block=origin.closest('.blk');if(block)PR.jumpTo(block.id,{noBack:true});}}
  });
  PR.on('rendered',()=>{if(PR.side==='refs')render();});
})(window.PR);
