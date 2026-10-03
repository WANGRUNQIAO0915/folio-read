(function (root) {
  'use strict';
  const ready = new Promise((resolve,reject) => {
    const request = indexedDB.open('folio-read-mobile',2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains('papers')) db.createObjectStore('papers',{keyPath:'paper_id'});
      if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      if(!db.objectStoreNames.contains('sources')) db.createObjectStore('sources',{keyPath:'paper_id'});
      if(!db.objectStoreNames.contains('indexes')) db.createObjectStore('indexes',{keyPath:'paper_id'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('手机存储不可用。请关闭私密浏览后重试。'));
  });
  async function transaction(store, mode, action) {
    const db = await ready;
    return new Promise((resolve,reject) => {
      const tx=db.transaction(store,mode), request=action(tx.objectStore(store));
      let result;
      if(request) request.onsuccess=()=>{result=request.result;};
      tx.oncomplete=()=>resolve(result);
      tx.onerror=tx.onabort=()=>reject(new Error('保存失败，可能是设备空间不足。请先备份阅读文件。'));
    });
  }
  let writes = Promise.resolve();
  function serial(action) {
    const result=writes.then(action);writes=result.catch(()=>{});return result;
  }
  const store = {
    all:()=>transaction('papers','readonly',s=>s.getAll()),
    get:id=>transaction('papers','readonly',s=>s.get(id)),
    save:data=>serial(()=>transaction('papers','readwrite',s=>s.put(data))),
    source:(id,data)=>data===undefined ? transaction('sources','readonly',s=>s.get(id)) : serial(()=>transaction('sources','readwrite',s=>s.put({paper_id:id,...data}))),
    indexes:()=>transaction('indexes','readonly',s=>s.getAll()),
    saveIndex:data=>serial(()=>transaction('indexes','readwrite',s=>s.put(data))),
    importBundle:data=>serial(async()=>{
      const old=await store.get(data.paper_id);
      if(old){
        if(data.paper.meta.text_status==='original' && old.paper.meta.text_status!=='original') {data.paper=old.paper;data.images=old.images;data.discussion=old.discussion;}
        data.cloud_content_hash=old.cloud_content_hash;
        data.content_dirty=old.content_dirty || root.FolioMobile.canonical(data.paper)!==root.FolioMobile.canonical(old.paper);
        data.pending=(old.pending || []).concat(root.FolioMobile.readerEvents(data.reader,'import-'+crypto.randomUUID()));
        data.reader=root.FolioMobile.materialize([old.reader,data.reader],data.pending);
        data.bound_account=old.bound_account;data.synced_once=old.synced_once;
      }
      await transaction('papers','readwrite',s=>s.put(data));return data;
    }),
    update:(id,fn)=>serial(async()=>{
      const data=await store.get(id);if(!data) throw new Error('找不到这篇论文。');
      fn(data);await transaction('papers','readwrite',s=>s.put(data));return data;
    }),
    setting:(key,value)=>value===undefined ? transaction('settings','readonly',s=>s.get(key)) : transaction('settings','readwrite',s=>s.put(value,key)),
    commit:(id,ops)=>serial(async()=>{
      const data=await store.get(id);
      if(!data) throw new Error('找不到这篇论文。');
      let reader=data.reader;
      for(const op of ops) {
        const event=root.FolioMobile.cloudOp(reader,op,crypto.randomUUID());
        data.pending=(data.pending || []).concat(event);
        reader=root.FolioMobile.applyOps(reader,[op]);
      }
      data.pending=root.FolioMobile.compact(data.pending);data.reader=reader;
      data.opened_at=new Date().toISOString();
      await transaction('papers','readwrite',s=>s.put(data));return data;
    }),
    mergeRemote:(id,reader,sentIds,metadata={})=>serial(async()=>{
      const data=await store.get(id);if(!data) return null;
      data.pending=(data.pending || []).filter(op=>!sentIds.has(op.event_id));
      data.reader=root.FolioMobile.materialize([reader],data.pending);
      const expected=metadata.expected_content;delete metadata.expected_content;
      if(expected && expected!==root.FolioMobile.canonical({paper:data.paper,images:data.images,discussion:data.discussion,item:data.item})) {
        for(const key of ['paper','images','discussion','item'])delete metadata[key];
        metadata.content_dirty=true;
      }
      Object.assign(data,metadata);
      data.synced_at=new Date().toISOString();data.synced_once=true;
      await transaction('papers','readwrite',s=>s.put(data));return data;
    })
  };
  root.FolioStorage=store;
})(window);
