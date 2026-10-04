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
  const O=root.FolioOrganization,C=root.FolioMobile;
  async function readOrganization(){const stored=await store.setting('organization');if(stored&&(stored.schema!==1||!stored.folders||typeof stored.folders!=='object'||Array.isArray(stored.folders)||!stored.assignments||typeof stored.assignments!=='object'||Array.isArray(stored.assignments)))throw new Error('文献分类数据格式无效，请先保留备份后恢复。');return O.seed(stored,await store.all());}
  let writes = Promise.resolve();
  function serial(action) {
    const result=writes.then(action);writes=result.catch(()=>{});return result;
  }
  const store = {
    organization:()=>readOrganization(),
    changeOrganization:fn=>serial(async()=>{const next=O.normalize(fn(await readOrganization()));await store.setting('organization',next);return next;}),
    mergeOrganization:value=>serial(async()=>{const next=O.merge(await readOrganization(),value);await store.setting('organization',next);return next;}),
    all:()=>transaction('papers','readonly',s=>s.getAll()),
    get:id=>transaction('papers','readonly',s=>s.get(id)),
    save:data=>serial(()=>transaction('papers','readwrite',s=>s.put(data))),
    source:(id,data)=>data===undefined ? transaction('sources','readonly',s=>s.get(id)) : serial(()=>transaction('sources','readwrite',s=>s.put({paper_id:id,...data}))),
    indexes:()=>transaction('indexes','readonly',s=>s.getAll()),
    saveIndex:data=>serial(()=>transaction('indexes','readwrite',s=>s.put(data))),
    importBundle:(data,options={})=>serial(async()=>{
      if(data.organization&&O){const next=O.merge(await readOrganization(),data.organization);await store.setting('organization',next);}
      const old=await store.get(data.paper_id);
      if(old && options.preserveExisting)return old;
      if(old){
        if(data.paper.meta.text_status==='original' && old.paper.meta.text_status!=='original') {data.paper=old.paper;data.images=old.images;data.discussion=old.discussion;}
        const naming=C.preferNaming(data.item?.naming,old.item?.naming);
        if(naming){data.item={...data.item,naming};data.naming_dirty=old.naming_dirty || C.canonical(naming)!==C.canonical(C.cleanNaming(old.item?.naming));}
        data.cloud_content_hash=old.cloud_content_hash;data.cloud_article_content_hash=old.cloud_article_content_hash;
        data.content_dirty=old.content_dirty || root.FolioMobile.canonical(data.paper)!==root.FolioMobile.canonical(old.paper);
        data.pending=(old.pending || []).concat(root.FolioMobile.readerEvents(data.reader,'import-'+crypto.randomUUID()));
        data.reader=root.FolioMobile.materialize([old.reader,data.reader],data.pending);
        data.bound_account=old.bound_account;data.synced_once=old.synced_once;
      }
      await transaction('papers','readwrite',s=>s.put(data));return data;
    }),
    applyNaming:changes=>serial(async()=>{
      if(!Array.isArray(changes)||!changes.length||changes.length>20)throw new Error('每批请选择 1–20 篇论文。');
      const seen=new Set();
      for(const change of changes){if(!C.safeKey(change.paper_id)||seen.has(change.paper_id))throw new Error('论文标识无效或重复。');seen.add(change.paper_id);}
      const db=await ready;
      // Read versions and write the complete batch in the same transaction. This
      // serializes competing PWA tabs as well as actions in this window.
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('papers','readwrite'),papers=tx.objectStore('papers'),loaded=new Array(changes.length);let remaining=changes.length,next=[];
        tx.onerror=tx.onabort=()=>reject(new Error('名称保存失败，原名称保留，请重试。'));
        tx.oncomplete=()=>resolve(next);
        changes.forEach((change,index)=>{
          const request=papers.get(change.paper_id);
          request.onsuccess=()=>{
            loaded[index]=request.result;if(--remaining)return;
            try{
              next=changes.map((change,i)=>{
                const data=loaded[i];if(!data)throw new Error('请先将论文下载到此设备，再编辑名称。');
                const previous=C.cleanNaming(data.item?.naming);
                if((previous?.version||'')!==change.expected_version)throw new Error('名称已在其他操作中更新，请重新预览后保存。');
                const updated=new Date(Math.max(Date.now(),C.time(previous?.updated)+1)).toISOString();
                const naming=C.makeNaming(data,change.title,change.source,crypto.randomUUID(),updated);
                return {...data,item:{...data.item,naming},naming_dirty:true};
              });
              next.forEach(data=>papers.put(data));
            }catch(error){reject(error);tx.abort();}
          };
        });
      });
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
      if(metadata.item){
        const remote=C.cleanNaming(metadata.item.naming),naming=C.preferNaming(data.item?.naming,remote);
        if(naming){metadata.item={...metadata.item,naming};metadata.naming_dirty=C.canonical(naming)!==C.canonical(remote);}
      }
      Object.assign(data,metadata);
      data.synced_at=new Date().toISOString();data.synced_once=true;
      await transaction('papers','readwrite',s=>s.put(data));return data;
    })
  };
  root.FolioStorage=store;
})(window);
