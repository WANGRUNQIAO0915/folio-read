/* Logical library organization. No PDF or document body is moved or rewritten. */
(function(root){
  'use strict';
  const key=v=>typeof v==='string'&&v.length>0&&v.length<200&&!['__proto__','prototype','constructor'].includes(v);
  const copy=v=>JSON.parse(JSON.stringify(v));
  function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
  const empty=()=>({schema:1,folders:{},assignments:{}});
  function cleanVersion(v){return v&&typeof v.at==='string'&&typeof v.id==='string'&&(v.at===''||Number.isFinite(Date.parse(v.at)))&&v.id.length<=200?{at:v.at,id:v.id}:{at:'',id:''};}
  function tags(value,strict=false,generous=false){const limit=(!strict||generous)?500:12,width=(!strict||generous)?500:40;if(!Array.isArray(value)){if(strict)throw new Error('标签必须是列表。');return [];}if(strict&&value.length>limit)throw new Error('每篇论文最多 '+limit+' 个标签。');const out=[],seen=new Set();for(const raw of value){if(typeof raw!=='string'){if(strict)throw new Error('标签必须是文字。');continue;}const tag=raw.trim();if(!tag||/[\x00-\x1f]/.test(raw)){if(strict)throw new Error('标签不能为空或包含控制字符。');continue;}if([...tag].length>width){if(strict)throw new Error('每个标签最多 '+width+' 个字符。');continue;}const k=tag.toLowerCase();if(!seen.has(k)){out.push(tag);seen.add(k);}}if(strict&&out.length>limit)throw new Error('每篇论文最多 '+limit+' 个标签。');return out.slice(0,limit);}
  function name(value){if(typeof value!=='string'||!value.trim()||/[\x00-\x1f]/.test(value)||[...value.trim()].length>80)throw new Error('文件夹名称需为 1–80 个字符。');return value.trim();}
  function normalize(value){const out=empty();if(!value||typeof value!=='object')return out;for(const [id,f] of Object.entries(value.folders||{})){if(!key(id)||!f||typeof f.name!=='string'||!f.name.trim()||/[\x00-\x1f]/.test(f.name)||[...f.name.trim()].length>80)continue;out.folders[id]={id,name:f.name.trim(),parent_id:key(f.parent_id)?f.parent_id:null,version:cleanVersion(f.version),deleted:f.deleted===true};}for(const [id,a] of Object.entries(value.assignments||{})){if(!key(id)||!a||typeof a!=='object')continue;out.assignments[id]={folder_id:key(a.folder_id)?a.folder_id:null,tags:tags(a.tags),version:cleanVersion(a.version)};}return out;}
  function parent(value,id){const org=normalize(value),edges={};for(const f of Object.values(org.folders))if(!f.deleted)edges[f.id]=org.folders[f.parent_id]&&!org.folders[f.parent_id].deleted&&f.parent_id!==f.id?f.parent_id:null;const order=[],seen=new Set();let cursor=id;while(Object.hasOwn(edges,cursor)&&!seen.has(cursor)){seen.add(cursor);order.push(cursor);cursor=edges[cursor];}if(seen.has(cursor))edges[order.slice(order.indexOf(cursor)).sort()[0]]=null;return edges[id]||null;}
  function folderPath(value,id){const org=normalize(value),labels=[],seen=new Set();while(id&&org.folders[id]&&!seen.has(id)){seen.add(id);labels.unshift(org.folders[id].name);id=parent(org,id);}return labels.join(' / ');}
  function within(value,id,ancestor){const seen=new Set();while(id&&!seen.has(id)){if(id===ancestor)return true;seen.add(id);id=parent(value,id);}return false;}
  function tree(value){const out=[],org=normalize(value),walk=(id,depth)=>{const f=org.folders[id];out.push({...f,parent_id:parent(org,id),depth,path:folderPath(org,id)});for(const c of live(org).filter(c=>parent(org,c.id)===id))walk(c.id,depth+1);};for(const f of live(org).filter(f=>!parent(org,f.id)))walk(f.id,0);return out;}
  function compare(a,b){const av=a.version,bv=b.version;const time=(Date.parse(av.at)||0)-(Date.parse(bv.at)||0);return time|| (av.id<bv.id?-1:av.id>bv.id?1:0)|| (canonical(a)<canonical(b)?-1:canonical(a)>canonical(b)?1:0);}
  function merge(...values){const out=empty();for(const value of values){const normalized=normalize(value);for(const kind of ['folders','assignments'])for(const [id,record] of Object.entries(normalized[kind])){const prior=out[kind][id];if(!prior||(kind==='folders'&&record.deleted&&!prior.deleted)||(!(kind==='folders'&&prior.deleted&&!record.deleted)&&compare(record,prior)>0))out[kind][id]=record;}}return out;}
  function seed(value,papers){const out=normalize(value);for(const p of papers||[]){const id=p.paper_id;if(key(id)&&!out.assignments[id])out.assignments[id]={folder_id:null,tags:tags(p.item?.tags),version:{at:'',id:''}};}return out;}
  function assignment(value,id){const org=normalize(value),a=org.assignments[id]||{folder_id:null,tags:[],version:{at:'',id:''}};return {...a,folder_id:a.folder_id&&org.folders[a.folder_id]&&!org.folders[a.folder_id].deleted?a.folder_id:null};}
  function version(){const cryptoAPI=root.crypto||(typeof require==='function'?require('node:crypto'):null);return {at:new Date().toISOString(),id:cryptoAPI.randomUUID()};}
  function nextVersion(value,v){const org=normalize(value),max=Math.max(0,...Object.values(org.folders).concat(Object.values(org.assignments)).map(r=>Date.parse(r.version.at)||0));return {...v,at:new Date(Math.max(Date.parse(v.at)||Date.now(),max+1)).toISOString()};}
  function live(value){return Object.values(normalize(value).folders).filter(f=>!f.deleted).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));}
  function createFolder(value,folderName,v=version(),parentId=null){const out=normalize(value),n=name(folderName);v=nextVersion(out,v);if(parentId&&(!out.folders[parentId]||out.folders[parentId].deleted))throw new Error('父文件夹不存在。');if(live(out).some(f=>f.name.toLowerCase()===n.toLowerCase()&&parent(out,f.id)===parentId))throw new Error('已有同名文件夹。');const id='folder-'+v.id;out.folders[id]={id,name:n,parent_id:parentId,version:v,deleted:false};return out;}
  function renameFolder(value,id,folderName,v=version()){const out=normalize(value),n=name(folderName);v=nextVersion(out,v);if(!out.folders[id]||out.folders[id].deleted)throw new Error('文件夹已删除，请刷新后重试。');if(live(out).some(f=>f.id!==id&&f.name.toLowerCase()===n.toLowerCase()&&parent(out,f.id)===parent(out,id)))throw new Error('已有同名文件夹。');out.folders[id]={...out.folders[id],name:n,version:v};return out;}
  function moveFolder(value,id,parentId,v=version()){const out=normalize(value);if(!out.folders[id]||out.folders[id].deleted||parentId&&(!out.folders[parentId]||out.folders[parentId].deleted))throw new Error('文件夹不存在。');if(parentId&&within(out,parentId,id))throw new Error('不能把文件夹移入自身或子文件夹。');if(live(out).some(f=>f.id!==id&&f.name.toLowerCase()===out.folders[id].name.toLowerCase()&&parent(out,f.id)===parentId))throw new Error('目标位置已有同名文件夹。');out.folders[id]={...out.folders[id],parent_id:parentId||null,version:nextVersion(out,v)};return out;}
  function deleteFolder(value,id,v=version()){const out=normalize(value);v=nextVersion(out,v);if(!out.folders[id]||out.folders[id].deleted)throw new Error('文件夹已删除。');out.folders[id]={...out.folders[id],deleted:true,version:v};return out;}
  function assign(value,changes,v=version()){
    const out=normalize(value);v=nextVersion(out,v);
    if(!Array.isArray(changes)||!changes.length)throw new Error('请选择论文。');
    const ids=new Set();
    for(const c of changes){
      if(!key(c.paper_id)||ids.has(c.paper_id))throw new Error('论文标识无效或重复。');ids.add(c.paper_id);
      if(c.expected_version&&canonical(cleanVersion(c.expected_version))!==canonical(out.assignments[c.paper_id]?.version||{at:'',id:''}))throw new Error('论文分类已在其他操作中更新，请重新打开并检查。');
      if(Object.hasOwn(c,'tags'))tags(c.tags,true,true);
      if(Object.hasOwn(c,'folder_path')){if(!Array.isArray(c.folder_path)||!c.folder_path.length||c.folder_path.length>12||c.folder_id||c.folder_name)throw new Error('文件夹路径无效，最多支持 12 层目录。');c.folder_path.forEach(name);}
      else if(c.folder_name){if(c.folder_id)throw new Error('不能同时指定已有和新建文件夹。');name(c.folder_name);}
      else if(c.folder_id&&(!out.folders[c.folder_id]||out.folders[c.folder_id].deleted))throw new Error('目标文件夹已删除，请重新选择。');
    }
    for(const c of changes){
      const prior=assignment(out,c.paper_id);let folder=Object.hasOwn(c,'folder_id')?(c.folder_id||null):prior.folder_id;
      if(c.folder_name||c.folder_path){folder=null;for(const part of c.folder_path||[c.folder_name]){const n=name(part),existing=live(out).find(f=>f.name.toLowerCase()===n.toLowerCase()&&parent(out,f.id)===folder);if(existing){folder=existing.id;continue;}const fv=nextVersion(out,version()),id='folder-'+fv.id;out.folders[id]={id,name:n,parent_id:folder,version:fv,deleted:false};folder=id;}}
      out.assignments[c.paper_id]={folder_id:folder,tags:Object.hasOwn(c,'tags')?tags(c.tags,true,true):prior.tags,version:copy(v)};
    }
    return out;
  }
  function subset(value,ids){const out=normalize(value),set=new Set(ids);out.assignments=Object.fromEntries(Object.entries(out.assignments).filter(([id])=>set.has(id)));return out;}
  function exportSubset(value,ids){const out=subset(value,ids),referenced=new Set(Object.values(out.assignments).map(a=>a.folder_id).filter(Boolean));for(let id of [...referenced]){const seen=new Set();while(id&&!seen.has(id)){seen.add(id);id=parent(out,id);if(id)referenced.add(id);}}out.folders=Object.fromEntries(Object.entries(out.folders).filter(([id])=>referenced.has(id)));return out;}
  const api={empty,normalize,merge,seed,assignment,version,live,parent,path:folderPath,within,tree,createFolder,renameFolder,moveFolder,deleteFolder,assign,subset,exportSubset,tags,canonical};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FolioOrganization=api;
})(typeof window==='undefined'?{}:window);
