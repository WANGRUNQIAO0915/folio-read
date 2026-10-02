/* Portable journal metadata; no provider credentials or requests in this module. */
(function(root){
  'use strict';
  const LABELS = {"sciUp": "中科院（升级版）", "sci": "JCR · SCI", "ssci": "JCR · SSCI", "sciif": "影响因子（JCR）", "sciUpSmall": "中科院 · 小类", "sciUpTop": "中科院 · Top", "sciBase": "中科院（基础版）", "sciif5": "五年影响因子", "jci": "JCI", "ccf": "CCF", "cssci": "CSSCI", "pku": "北大核心", "sciwarn": "中科院预警", "cscd": "CSCD", "eii": "EI", "ahci": "A&HCI", "ajg": "AJG / ABS", "fms": "FMS", "ft50": "FT50", "utd24": "UTD24", "esi": "ESI", "zhongguokejihexin": "中国科技核心", "xr": "新锐学术", "xrWarn": "新锐学术预警", "xrTop": "新锐学术 · Top", "xrSmall": "新锐学术 · 小类", "swufe": "西南财经大学", "cufe": "中央财经大学", "uibe": "对外经济贸易大学", "sdufe": "山东财经大学", "xdu": "西安电子科技大学", "swjtu": "西南交通大学", "ruc": "中国人民大学", "xmu": "厦门大学", "sjtu": "上海交通大学", "fdu": "复旦大学", "hhu": "河海大学", "scu": "四川大学", "cqu": "重庆大学", "nju": "南京大学", "xju": "新疆大学", "cug": "中国地质大学", "cju": "长江大学", "zju": "浙江大学", "cpu": "中国药科大学"};
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const name=s=>String(s||'').normalize('NFKC').trim().replace(/\s+/g,' ');
  function clean(value){
    if(!value || value.source!=='easyScholar')return null;
    const publication=name(value.publication);if(!publication || publication.length>256)return null;
    const metrics=(Array.isArray(value.metrics)?value.metrics:[]).slice(0,60).flatMap(m=>{
      if(!m || typeof m!=='object')return [];
      const key=String(m.key||'').slice(0,80),label=LABELS[key] || (/^custom:[\w-]{1,64}$/.test(key)?String(m.label||'').slice(0,60):'');
      const text=['string','number'].includes(typeof m.value)?String(m.value).trim().slice(0,500):'';
      return label&&text?[{key,label,value:text}]:[];
    });
    const at=String(value.queried_at||'').slice(0,40);
    return {source:'easyScholar',publication,queried_at:Number.isFinite(Date.parse(at))?at:'',status:metrics.length?'found':'not_found',metrics};
  }
  function visible(meta){const rank=clean(meta?.journal_rank);return rank && name(meta.venue).toLowerCase()===rank.publication.toLowerCase()?rank:null;}
  function badges(meta){const rank=visible(meta);if(!rank?.metrics.length)return '';
    const metrics=rank.metrics.filter(m=>['sciUp','sci','ssci','sciif','ccf','cssci','pku'].includes(m.key)).slice(0,4);
    return '<div class="journal-badges">'+(metrics.length?metrics:rank.metrics.slice(0,3)).map(m=>'<span title="'+esc(m.label)+' · easyScholar">'+esc(m.label)+' <b>'+esc(m.value)+'</b></span>').join('')+'</div>';
  }
  function details(meta){const rank=visible(meta);if(!rank)return '<p class="hint">尚未查询。请填写正式期刊或会议全称；预印本平台没有期刊分区。</p>';
    return '<p class="journal-publication">'+esc(rank.publication)+'</p>'+(rank.metrics.length?'<dl class="journal-metrics">'+rank.metrics.map(m=>'<div><dt>'+esc(m.label)+'</dt><dd>'+esc(m.value)+'</dd></div>').join('')+'</dl>':'<p class="hint">easyScholar 未返回该期刊的分区数据，请核对期刊全称。</p>')+
      '<p class="journal-source">来源：easyScholar · 查询于 '+esc(rank.queried_at.slice(0,10)||'未知日期')+'<br>接口未提供数据年份；分区属于期刊评价，不能直接代表这篇论文的质量。</p>';
  }
  function panel(meta,id,online){return '<section class="journal-panel"><h4>期刊分区</h4>'+details(meta)+(online?'<div class="journal-query"><input class="input" data-journal-name aria-label="期刊或会议全称" placeholder="期刊或会议全称" value="'+esc(meta.venue||'')+'" maxlength="256"><button class="btn sm" data-journal-lookup="'+esc(id)+'">'+(visible(meta)?'刷新分区':'查询分区')+'</button></div>':'')+'</section>';}
  const api={LABELS,clean,visible,badges,details,panel};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FolioJournal=api;
})(typeof window==='undefined'?{}:window);
