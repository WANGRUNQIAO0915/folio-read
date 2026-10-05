// Real rendering/export functions in jsdom. No claims about PDF layout or native APIs.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {JSDOM} = require(process.env.JSDOM || 'jsdom');
const ROOT = path.resolve(__dirname, '../easyread/web');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-print-dom-'));
const PYTHON = process.env.PYTHON || 'python';
execFileSync(PYTHON, [path.join(__dirname, 'translation_print_support.py'), 'fixture', TEMP], {
  env: {...process.env, EASYREAD_HOME: TEMP, EASYREAD_LIBRARY: path.join(TEMP, 'library')}, encoding: 'utf8',
});
const fixture = JSON.parse(fs.readFileSync(path.join(TEMP, 'state.json'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
let disk = clone(fixture), stateReads = 0, calls = 0, confirmed = true, failState = false, failOps = false;
let imageMode = '', fontReady = Promise.resolve(), releaseImage, releaseBridge, confirmText = '';
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'reader.html'), 'utf8'), {
  url: 'http://127.0.0.1/read/print-fixture', runScripts: 'outside-only', pretendToBeVisual: true,
});
const w = dom.window, d = w.document;
w.matchMedia = () => ({matches: false, addEventListener() {}});
w.scrollTo = w.scrollBy = () => {};
w.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
w.HTMLDialogElement.prototype.close = function (value = '') {this.returnValue = value; this.open = false; this.dispatchEvent(new w.Event('close'));};
Object.defineProperty(d, 'fonts', {value: {get ready() {return fontReady;}}});
w.HTMLImageElement.prototype.decode = function () {
  if (imageMode === 'hold') return new Promise(resolve => {releaseImage = resolve;});
  if (imageMode === 'fail-all' || (imageMode === 'fail-figure' && this.src.includes('/figures/'))) return Promise.reject(new Error('synthetic decode failure'));
  return Promise.resolve();
};
w.fetch = async (url, options = {}) => {
  if (url.endsWith('/state')) {stateReads++; if (failState) return {ok: false, status: 503}; return {ok: true, json: async () => clone(disk)};}
  if (url.endsWith('/ops')) {
    if (failOps) throw new Error('offline');
    for (const op of JSON.parse(options.body).ops) if (op.op === 'edit') disk.reader.edits[op.block] = {zh: op.zh, at: op.at};
    return {ok: true, json: async () => ({rev: 5, versions: {}})};
  }
  throw new Error('Unexpected fetch: ' + url);
};
for (const file of ['vendor/katex/katex.min.js', 'js/common/util.js', 'js/common/citations.js', 'js/common/markup.js',
  'js/common/journal-rank.js', 'js/reader/store.js', 'js/reader/outline.js', 'js/reader/render.js', 'js/reader/translation-print.js']) {
  w.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}
const PR = w.PR, messages = [];
PR.toast = text => messages.push(text);
PR.confirm = async options => {confirmText = options.body; return confirmed;};
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(test) {for (let i = 0; i < 100; i++) {if (test()) return; await tick();} throw Error('Timed out waiting for test state');}
function clean(label) {
  assert.equal(d.querySelectorAll('#translationPrint').length, 0, label + ': no leftover root');
  assert.equal(d.body.classList.contains('translation-print-active'), false, label + ': print mode off');
  assert.equal(d.querySelector('[data-translation-export]').disabled, false, label + ': button enabled');
}
function native(implementation) {w.pywebview = {api: {export_translation_pdf: async filename => {calls++; return implementation(filename);}}};}
function prepare(mode) {return PR.prepareTranslationPrint(mode);}

(async () => {
  try {
    await PR.load();
    PR.renderPaper();
    const readerBefore = d.querySelector('#paper').innerHTML;
    let snapshot = await prepare();
    assert.equal(snapshot.root.className, 'translation-print zh');
    assert.equal(snapshot.root.lang, 'zh-CN');
    assert.equal(snapshot.failedImages, 0);
    assert.match(snapshot.warnings.join(' '), /1 页未完成翻译/);
    assert.match(snapshot.warnings.join(' '), /3 处缺少译文/);
    for (const token of ['SAVED_PARAGRAPH', 'SAVED_LIST', 'SAVED_CAPTION', 'REFERENCE_SENTINEL']) assert(snapshot.root.textContent.includes(token));
    for (const token of ['OLD_PARAGRAPH_TRANSLATION', 'OLD_LIST_TRANSLATION', 'OLD_FIGURE_CAPTION', 'OLD_EMPTY_CAPTION',
      'PRIVATE_INLINE_AGENT_NOTE', 'PRIVATE_READER_NOTE', 'PRIVATE_DISCUSSION', 'PRIVATE_PAPER_NOTE']) assert(!snapshot.root.textContent.includes(token));
    assert.equal(snapshot.root.querySelectorAll('button, .edited-dot, .figure-tools, .inline-note, mark').length, 0);
    assert.match(snapshot.root.querySelector('#print-b-list li:nth-child(2) .original-primary').textContent, /SOURCE_EMPTY_LIST/);
    assert.match(snapshot.root.querySelector('#print-b-empty-caption .original-primary').textContent, /SOURCE_EMPTY_CAPTION/);
    assert.match(snapshot.root.querySelector('#print-b-missing .original-primary').textContent, /MISSING_TRANSLATION_SOURCE/);
    assert(snapshot.root.querySelector('#print-ref-1'));
    assert.equal(snapshot.root.querySelectorAll('details:not([open]), summary').length, 0);
    assert(snapshot.root.querySelectorAll('.katex').length >= 2);
    assert([...snapshot.root.querySelectorAll('img')].every(image => image.loading === 'eager'));
    assert.equal(d.querySelector('#paper').innerHTML, readerBefore, 'Preparing a print snapshot never edits the reading DOM');
    const first = snapshot.root;
    snapshot = await prepare('bi');
    assert.equal(first.isConnected, false);
    assert.equal(snapshot.root.className, 'translation-print bi');
    assert.equal(d.querySelectorAll('#translationPrint').length, 1);
    snapshot.root.remove();
    // Font and image promises really block preparation; these are not fixed sleeps.
    let releaseFont;
    fontReady = new Promise(resolve => {releaseFont = resolve;});
    let finished = false;
    const pendingFont = prepare().then(result => {finished = true; return result;});
    await tick(); assert.equal(finished, false); releaseFont();
    (await pendingFont).root.remove(); fontReady = Promise.resolve();
    // Hold exactly one decode while the other images use real fulfilled promises.
    const decode = w.HTMLImageElement.prototype.decode;
    let once = true;
    w.HTMLImageElement.prototype.decode = function () {if (once) {once = false; return new Promise(resolve => {releaseImage = resolve;});} return decode.call(this);};
    finished = false;
    const pendingImage = prepare().then(result => {finished = true; return result;});
    await until(() => !!releaseImage); assert.equal(finished, false); releaseImage();
    (await pendingImage).root.remove(); w.HTMLImageElement.prototype.decode = decode;
    // Failed figure decode falls back to the original page, with an explicit warning.
    imageMode = 'fail-figure'; snapshot = await prepare();
    assert.equal(snapshot.failedImages, 0);
    assert.match(snapshot.warnings.join(' '), /2 张插图使用所在原文页/);
    assert(snapshot.root.querySelector('#print-b-fig img').src.includes('/pages/'));
    assert.match(snapshot.root.querySelector('#print-b-fig').textContent, /插图加载失败/);
    snapshot.root.remove();
    imageMode = 'fail-all'; snapshot = await prepare();
    assert.equal(snapshot.failedImages, 3);
    assert.equal(snapshot.root.querySelectorAll('img').length, 0);
    assert.match(snapshot.root.textContent, /图片未能加载/);
    snapshot.root.remove(); imageMode = '';
    // A figure with no crop attaches its available original page. No page means a visible missing-image count.
    PR.state.paper.blocks.push({id: 'no-crop', type: 'figure', page: 1, caption_zh: '无裁图'},
      {id: 'no-image', type: 'figure', page: 99, caption_zh: '无任何图片'});
    snapshot = await prepare();
    assert(snapshot.root.querySelector('#print-b-no-crop img[data-original-fallback]'));
    assert.match(snapshot.root.querySelector('#print-b-no-crop').textContent, /下方附原页/);
    assert.equal(snapshot.failedImages, 1);
    snapshot.root.remove(); PR.state.paper = clone(fixture.paper);
    // Font failures and timeouts remove the already-created snapshot.
    fontReady = Promise.reject(new Error('synthetic font error'));
    await assert.rejects(prepare(), /synthetic font error/); clean('font failure'); fontReady = Promise.resolve();
    const realTimer = w.setTimeout;
    w.setTimeout = (fn, ms, ...args) => realTimer.call(w, fn, ms >= 15000 ? 15 : ms, ...args);
    fontReady = new Promise(() => {});
    await assert.rejects(prepare(), /字体加载超时/); clean('font timeout'); fontReady = Promise.resolve();
    imageMode = 'hold'; await assert.rejects(prepare(), /图片加载超时/); clean('image timeout'); imageMode = '';
    w.setTimeout = realTimer;
    PR.editingKey = 'p-edit'; await assert.rejects(prepare(), /先保存或取消/); PR.editingKey = null;
    await assert.rejects(prepare('unexpected'), /未知导出模式/);
    PR.state.paper = {meta: {pages: []}, blocks: []}; await assert.rejects(prepare(), /尚未准备好/); PR.state.paper = clone(fixture.paper);
    // Export refreshes a newer saved edit before handing any content to the native bridge.
    disk.reader.edits['p-edit'].zh = 'LATEST_SAVED_DISK_EDIT';
    disk.reader.edits['p-edit'].at = '2026-02-01T00:00:00Z';
    native(filename => {
      assert.match(filename, /-中文译文\.pdf$/);
      assert.equal(d.body.classList.contains('translation-print-active'), true);
      assert.match(d.querySelector('#translationPrint').textContent, /LATEST_SAVED_DISK_EDIT/);
      return {status: 'saved'};
    });
    const beforeReads = stateReads;
    const initialExport = await PR.exportTranslationPdf();
    assert.equal(initialExport.status, 'saved', JSON.stringify(initialExport));
    assert(stateReads > beforeReads); clean('native success');
    // Cancel confirmation does not call the native bridge.
    confirmed = false; const beforeCalls = calls;
    assert.equal((await PR.exportTranslationPdf()).status, 'cancelled');
    assert.equal(calls, beforeCalls); clean('confirmation cancelled'); confirmed = true;
    // Coalesce repeated exports while a native operation is in progress.
    native(() => new Promise(resolve => {releaseBridge = resolve;}));
    const inFlight = PR.exportTranslationPdf('bi');
    await until(() => !!releaseBridge);
    assert.equal(d.querySelector('[data-translation-export]').disabled, true);
    assert.equal((await PR.exportTranslationPdf()).status, 'busy');
    assert.equal(d.querySelectorAll('#translationPrint').length, 1);
    releaseBridge({status: 'cancelled'});
    assert.equal((await inFlight).status, 'cancelled'); clean('native cancelled');
    native(() => ({status: 'error', error: '<img src=x onerror=alert(1)> synthetic native error'}));
    assert.equal((await PR.exportTranslationPdf()).status, 'error');
    assert.match(messages.at(-1), /&lt;img/); clean('native error');
    native(() => {throw Error('synthetic bridge rejection');});
    assert.equal((await PR.exportTranslationPdf()).status, 'error'); clean('native rejects');
    w.pywebview = {api: {}};
    assert.equal((await PR.exportTranslationPdf()).status, 'error'); clean('unsupported desktop');
    delete w.pywebview;
    const title = d.title;
    w.print = () => {assert(d.body.classList.contains('translation-print-active')); assert.match(d.title, /-中文译文$/);};
    assert.equal((await PR.exportTranslationPdf()).status, 'print-dialog');
    assert.equal(d.title, title); clean('browser print cancelled');
    w.print = () => {throw new Error('synthetic print failure');};
    assert.equal((await PR.exportTranslationPdf()).status, 'error');
    assert.equal(d.title, title); clean('browser print throws');
    failState = true; assert.equal((await PR.exportTranslationPdf()).status, 'error'); clean('state fetch failure'); failState = false;
    // Unsynced local edits stay in the snapshot and are explicitly disclosed.
    failOps = true;
    PR.commit({op: 'edit', block: 'p-edit', zh: 'LOCAL_PENDING_EDIT'});
    native(() => {assert.match(d.querySelector('#translationPrint').textContent, /LOCAL_PENDING_EDIT/); return {status: 'saved'};});
    assert.equal((await PR.exportTranslationPdf()).status, 'saved');
    assert.match(confirmText, /尚未写入磁盘/); clean('pending local edit');
    console.log('Translated PDF DOM passed: saved paragraph/list/caption edits, empty translation fallback, source image fallback, readiness/timeout, fresh state, busy/cancel/error cleanup, browser title restoration, pending-edit disclosure.');
  } finally {dom.window.close(); fs.rmSync(TEMP, {recursive: true, force: true});}
})().catch(error => {console.error(error); process.exitCode = 1;});
