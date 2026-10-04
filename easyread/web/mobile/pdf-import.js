/* PDF 在设备内解析。解析库按固定版本加载，文件内容不会发送给 CDN。 */
(function (root) {
  'use strict';
  const VERSION='6.3.289', BASE=root.FolioPlatform?.pdfBase || 'https://cdn.jsdelivr.net/npm/pdfjs-dist@'+VERSION+'/';
  const MAX_SOURCE=128*1024*1024;
  let loading;
  async function engine() {
    if(!loading) loading=import(BASE+'legacy/build/pdf.mjs').then(pdf=>{
      pdf.GlobalWorkerOptions.workerSrc=BASE+'legacy/build/pdf.worker.mjs';return pdf;
    }).catch(()=>{loading=null;throw new Error(root.FolioPlatform?.bundledAssets ? '内置 PDF 组件未能加载。请更新 Android System WebView 后重试。' : 'PDF 解析组件未能加载。首次导入需要联网，请检查网络后重试。');});
    return loading;
  }
  async function sha(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  function paragraphs(items, page) {
    const lines=[]; let line='',lastY=null,lastX=0;
    for(const item of items) {
      if(typeof item.str!=='string') continue;
      const y=item.transform?.[5];
      if(lastY!==null && Math.abs(y-lastY)>3 && line.trim()){lines.push(line.trim());line='';}
      const gap=line && (item.transform?.[4] || 0)>lastX+1;
      line+=(gap?' ':'')+item.str;lastY=y;lastX=(item.transform?.[4] || 0)+(item.width || 0);
      if(item.hasEOL){if(line.trim())lines.push(line.trim());line='';lastY=null;}
    }
    if(line.trim())lines.push(line.trim());
    const blocks=[];let text='';
    const flush=()=>{if(text.trim())blocks.push({id:'pdf-p'+page+'-t'+blocks.length,type:'para',page,en:text.trim(),zh:''});text='';};
    for(const value of lines) {
      const match=value.match(/^(\d{1,2}(?:\.\d{1,2}){0,3})[.\s]+([A-Za-z\u4e00-\u9fff].{1,95})$/);
      if(match && !/[.;。；]$/.test(value)) {flush();blocks.push({id:'pdf-p'+page+'-t'+blocks.length,type:'heading',page,num:match[1],level:match[1].split('.').length,en:match[2],zh:''});}
      else {if(text.length+value.length>1400)flush();text+=(text?'\n':'')+value;}
    }
    flush();return blocks;
  }
  async function parse(file, onProgress) {
    if(file.size>MAX_SOURCE)throw new Error('PDF 超过 128 MB，请先压缩后导入。');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(!new TextDecoder().decode(bytes.slice(0,1024)).includes('%PDF-'))throw new Error('所选文件不是 PDF。');
    const digest=await sha(bytes),pdf=await engine();
    const task=pdf.getDocument({data:bytes.slice(),cMapUrl:BASE+'cmaps/',cMapPacked:true,standardFontDataUrl:BASE+'standard_fonts/',wasmUrl:BASE+'wasm/',isEvalSupported:false});
    let doc;
    try {
      doc=await task.promise;
      if(doc.numPages>300)throw new Error('当前手机导入最多支持 300 页，请拆分这份 PDF。');
      const info=await doc.getMetadata().catch(()=>({info:{}})),blocks=[],images={},pages=[];
      let imageBytes=0;
      for(let n=1;n<=doc.numPages;n++) {
        if(onProgress)onProgress(n,doc.numPages);
        const page=await doc.getPage(n),text=await page.getTextContent();
        blocks.push(...paragraphs(text.items,n));
        // 缩略原页用于离线核对；完整 PDF 单独保存，无损上传。
        if(imageBytes<32*1024*1024) {
          const base=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(1.6,720/base.width)});
          const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
          const context=canvas.getContext('2d');
          await page.render({canvasContext:context,viewport}).promise;
          const image=canvas.toDataURL('image/jpeg',.72),path='pages/page-'+String(n).padStart(3,'0')+'.jpg';
          images[path]=image;pages.push({n,img:path});imageBytes+=image.length;
          canvas.width=canvas.height=0;
        }
        page.cleanup();
      }
      const meta={title_en:info.info?.Title && !/^untitled|^microsoft word/i.test(info.info.Title) ? info.info.Title:file.name.replace(/\.pdf$/i,''),
        title_zh:'',authors:info.info?.Author || '',source:file.name,source_sha256:digest,pdf:'source.pdf',page_count:doc.numPages,pages,
        text_status:'original',extraction_note:blocks.length?'正文由设备从 PDF 提取，未翻译；复杂排版请核对原页。':'此 PDF 未提取到文字。原始文件已保留，扫描版需先进行 OCR 才能全文检索。'};
      return root.FolioMobile.normalize({paper_id:digest,paper:{meta,blocks,references:[]},images,reader:root.FolioMobile.emptyReader(),item:{added:new Date().toISOString(),tags:[],status:'unread'}});
    } catch(error) {
      if(error.name==='PasswordException')throw new Error('PDF 需要密码，请先在文件应用中准备可直接打开的副本。');
      throw error;
    } finally {await task.destroy();}
  }
  root.FolioPDF={parse,sha,paragraphs,MAX_SOURCE,BASE};
})(window);
