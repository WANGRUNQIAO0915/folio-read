// Focused UI behavior test with a minimal DOM double, without network or model calls.
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function element() {
  const classes = new Set();
  return {value:'',textContent:'',innerHTML:'',disabled:false,addEventListener(){},focus(){},
    classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)}};
}
const elements = Object.fromEntries(['importDlg','importBtn','fileInput','dropOverlay','arxivRef','arxivGo','importRefStatus','importFolder','autoTr'].map(id=>['#'+id,element()]));
const dialog = element();elements['#importDlg'].querySelector = () => dialog;
elements['#importFolder'].value = 'folder-a';elements['#autoTr'].checked = false;
let calls = [], loads = 0, selected = null, mode = 'fail', finish;
const L = {engine:'none',folder:'folder-a',folderOptions:()=>'<option value="folder-a">测试</option>',load:async()=>{loads++;},select:id=>{selected=id;},openReader(){}};
const PR = {lib:L,$:selector=>elements[selector],$$:()=>[],ls:{get:(_,fallback)=>fallback,set(){}},icon:()=>'',esc:String,toast(){},openSettings(){},
  api:async(route,options)=>{
    calls.push({route,body:options.body});
    if(mode==='pending')await new Promise(resolve=>finish=resolve);
    if(mode==='fail')throw new Error('无法连接检索服务，请检查网络和代理');
    return {id:'paper-one',new:true};
  }};
const window = {PR,addEventListener(){}};
vm.runInNewContext(fs.readFileSync('easyread/web/js/library/import.js','utf8'),{window,document:{addEventListener(){}},setTimeout:fn=>fn()});
(async()=>{
  PR.openImport();
  assert.match(dialog.innerHTML,/importRefStatus/);
  assert.match(dialog.innerHTML,/完整论文标题/);
  await PR.importRef('  Synthetic Reference Title  ');
  assert.equal(calls.length,1);
  assert.equal(calls[0].route,'/api/import-url');
  assert.equal(calls[0].body.ref,'Synthetic Reference Title');
  assert.equal(calls[0].body.folder_id,'folder-a');
  assert.equal(calls[0].body.translate,false);
  assert.match(elements['#importRefStatus'].textContent,/导入失败.*网络/);
  assert.equal(elements['#arxivGo'].disabled,false);
  assert.equal(elements['#importDlg'].classList.contains('open'),true);
  mode='pending';
  const pending=PR.importRef('10.5555/reference');
  assert.equal(elements['#arxivGo'].disabled,true);
  await PR.importRef('Must not start another import');
  assert.equal(calls.length,2);
  finish();await pending;
  assert.equal(loads,1);assert.equal(selected,'paper-one');
  assert.equal(elements['#importDlg'].classList.contains('open'),false);
  assert.equal(elements['#arxivGo'].disabled,false);
  mode='success';PR.openImport();await PR.importRef('10.5555/another');
  assert.equal(calls.length,3);assert.equal(loads,2);
  assert.equal(elements['#arxivGo'].disabled,false);
  console.log('Reference import UI: persistent failure, retry, concurrent-submit guard, folder/translation options and successful reopen passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
