/* Editable overrides stay separate from suggested defaults. */
(function(root){
  'use strict';
  function draft(row){return {...row,original:{folder_id:row.folder_id||null,tags:[...(row.tags||[])]},suggestion:null,folderText:'',tagsText:'',clearFolder:false,clearTags:false};}
  const fallback=d=>d.suggestion||d.original;
  function folderLabel(org,assignment){return assignment.folder_id ? org.path(org.state,assignment.folder_id) : assignment.folder_name||'';}
  function field(d,kind,org){if(kind==='folder')return {value:d.folderText,placeholder:d.clearFolder?'不设置文件夹':folderLabel(org,fallback(d))||'未分类',source:d.suggestion?'AI 建议':'原分类'};return {value:d.tagsText,placeholder:d.clearTags?'不添加标签':fallback(d).tags.join(', ')||'无标签',source:d.suggestion?'AI 建议':'原标签'};}
  function resolve(d,org){const a=fallback(d),text=d.folderText.trim();let folder={folder_id:a.folder_id||null,...(a.folder_name?{folder_name:a.folder_name}:{})};
    if(d.clearFolder)folder={folder_id:null};
    else if(text){const known=org.live(org.state).filter(f=>org.path(org.state,f.id).toLowerCase()===text.toLowerCase());if(known.length)folder={folder_id:known[0].id};else folder={folder_id:null,folder_path:text.split('/').map(x=>x.trim())};}
    const tags=d.clearTags?[]:d.tagsText.trim()?[...new Set(d.tagsText.split(/[,，;；]/).map(t=>t.trim()).filter(Boolean))]:[...a.tags];
    return {paper_id:d.paper_id,...folder,tags,expected_version:d.expected_version};
  }
  const api={draft,field,resolve};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FolioClassificationEditor=api;
})(typeof window==='undefined'?{}:window);
