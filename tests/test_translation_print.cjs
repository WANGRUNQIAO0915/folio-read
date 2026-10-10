// Real Chromium translated-PDF regression. All inputs are synthetic and local.
// Requires installed Python application + Playwright Chromium; never silently skips.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');
const PYTHON = process.env.PYTHON || 'python';
const ROOT = path.resolve(__dirname, '../easyread/web');
const SUPPORT = path.join(__dirname, 'translation_print_support.py');
const ARTIFACTS = path.resolve(process.env.BROWSER_ARTIFACTS || path.join(__dirname, 'shots', 'translation-print'));
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-translation-print-'));
fs.mkdirSync(ARTIFACTS, {recursive: true});
const environment = {...process.env, EASYREAD_HOME: TEMP, EASYREAD_LIBRARY: path.join(TEMP, 'library'), PYTHONIOENCODING: 'utf-8'};
const python = (mode, file) => JSON.parse(execFileSync(PYTHON, [SUPPORT, mode, file], {env: environment, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024}));
const files = python('fixture', TEMP);
const state = JSON.parse(fs.readFileSync(path.join(TEMP, 'state.json'), 'utf8'));
const errors = [], external = [], requests = [], reports = {};
let browser, context, page, server, origin, stateReads = 0, failure = '', stateError = false;
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function inspect(file, bilingual) {
  const result = python('inspect', file), text = result.text.normalize('NFKC').replace(/\u2eda/g, '页').replace(/\s+/g, '');
  // Chromium's Noto ToUnicode maps may use compatibility radicals (e.g. ⽂).
  // U+2EDA is the visually identical simplified 页 radical and lacks an NFKC
  // mapping. Preserve raw extraction and normalize only these glyph equivalents.
  fs.writeFileSync(file.replace(/\.pdf$/, '-inspection.json'), JSON.stringify(result, null, 2));
  assert(result.pages.length >= 3, 'The fixture must produce multiple real PDF pages');
  for (const token of ['保存后的中文段落', 'LATEST_DISK_PARAGRAPH', '保存后的列表', 'SAVED_LIST', 'SAVED_CAPTION',
    'SOURCE_EMPTY_LIST', 'SOURCE_EMPTY_CAPTION', 'MISSING_TRANSLATION_SOURCE', 'TABLE_VALUE_42', 'REFERENCE_SENTINEL',
    '译文尚不完整', '原文第4页', '译文段落24']) assert(text.includes(token), 'PDF missing ' + token);
  for (const token of ['OLD_PARAGRAPH_TRANSLATION', 'OLD_LIST_TRANSLATION', 'OLD_FIGURE_CAPTION', 'OLD_EMPTY_CAPTION',
    'OLD_EMPTY_LIST_TRANSLATION', 'PRIVATE_READER_NOTE', 'PRIVATE_INLINE_AGENT_NOTE', 'PRIVATE_DISCUSSION', 'PRIVATE_PAPER_NOTE',
    'CONTROL_SENTINEL', 'SIDEBAR_SENTINEL', 'Details']) assert(!text.includes(token), 'PDF leaked ' + token);
  for (const token of ['ORIGINAL_TRANSLATED_PARA', 'ORIGINAL_TRANSLATED_LIST', 'ORIGINAL_TRANSLATED_CAPTION', 'ORIGINAL_LONG_24']) {
    assert.equal(text.includes(token), bilingual, 'Wrong language mode for ' + token);
  }
  assert(result.pages.reduce((sum, item) => sum + item.images, 0) >= 3, 'Figure and original-page images are embedded in PDF');
  assert(result.pages.reduce((sum, item) => sum + item.figure_pixels, 0) > 1000, 'Embedded figure actually renders its colored pixels');
  assert(['x1', 'x24', '300'].every(token => text.includes(token)), 'Both ends and result of the wide equation remain in PDF text');
  assert.deepEqual(result.pages.flatMap(item => item.table_decimals).sort(), ['0.25', '0.50'], 'Printed table decimals remain intact on one line');
  for (const [number, item] of result.pages.entries()) {
    assert(Math.abs(item.width - 595.28) < 2 && Math.abs(item.height - 841.89) < 2, 'A4 page ' + (number + 1));
    assert.deepEqual(item.overflow, [], 'Text outside printable margins on page ' + (number + 1));
    assert.deepEqual(item.image_overflow, [], 'Image outside printable margins on page ' + (number + 1));
    assert(item.nonwhite_pixels > 1000, 'No blank PDF page ' + (number + 1));
    assert.deepEqual(item.corner, [255, 255, 255], 'PDF background is white');
    for (const pixel of item.original_backgrounds) assert.deepEqual(pixel, [255, 255, 255], 'Original-page image retains its white background');
  }
  return {pages: result.pages.length, images: result.pages.reduce((sum, item) => sum + item.images, 0)};
}

async function clean(label) {
  assert.equal(await page.locator('#translationPrint').count(), 0, label + ': snapshot removed');
  assert.equal(await page.evaluate(() => document.body.classList.contains('translation-print-active')), false, label + ': print state removed');
  assert.equal(await page.locator('[data-translation-export]').isDisabled(), false, label + ': export re-enabled');
}

async function readerLayout() {
  return page.evaluate(async () => {
    await document.fonts.ready;
    PR.fitWide();
    const properties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
      'textAlign', 'marginTop', 'marginBottom', 'paddingLeft', 'paddingRight',
      'borderTopWidth', 'borderBottomWidth'];
    const selectors = ['.paper-head h1', '.paper-information .title-en', '.paper-information .byline',
      '#b-intro', '#b-intro .zh', '#b-p-edit .zh', '#b-list li', '#b-fig .caption', '#b-math .math-row', '#b-math .katex',
      '#b-regular-table table', '#b-regular-table th', '#b-regular-table td', '#b-refs .refs'];
    const paper = document.getElementById('paper'), style = getComputedStyle(paper);
    return {width: paper.getBoundingClientRect().width,
      type: Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']
        .map(property => [property, style[property]])),
      elements: Object.fromEntries(selectors.map(selector => {
        const style = getComputedStyle(paper.querySelector(selector));
        return [selector, Object.fromEntries(properties.map(property => [property, style[property]]))];
      })), properties, preferences: {...PR.prefs},
      blockOrder: [...paper.querySelectorAll('section.blk:not(.blk-note)')].map(element => element.dataset.id)};
  });
}

async function printLayout(mode) {
  const expected = await page.evaluate(() => window.__readerLayout);
  const result = await page.evaluate(expected => {
    const root = document.getElementById('translationPrint'), rect = root.getBoundingClientRect();
    const overflow = [...root.querySelectorAll('.zh, .original-primary, table, .math-body, img')].filter(element => {
      if (!element.getClientRects().length) return false;
      const box = element.getBoundingClientRect();
      return box.left < rect.left - 2 || box.right > rect.right + 2 || element.scrollWidth > element.clientWidth + 2;
    }).map(element => ({block: element.closest('.blk')?.dataset.id, class: element.className,
      width: element.clientWidth, scroll: element.scrollWidth}));
    return {classes: root.className, color: getComputedStyle(root).color, background: getComputedStyle(root).backgroundColor,
      type: Object.fromEntries(Object.keys(expected.type).map(property => [property, getComputedStyle(root)[property]])),
      width: rect.width, fonts: document.fonts.status, overflow,
      elements: Object.fromEntries(Object.keys(expected.elements).map(selector => {
        const style = getComputedStyle(root.querySelector(selector.replaceAll('#b-', '#print-b-')));
        return [selector, Object.fromEntries(expected.properties.map(property => [property, style[property]]))];
      })),
      regularTableWrapped: root.querySelector('#print-b-regular-table table').classList.contains('print-fit-table'),
      blockOrder: [...root.querySelectorAll('section.blk')].map(element => element.dataset.id),
      readyImages: [...root.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0 && img.loading === 'eager'),
      imageFilters: [...root.querySelectorAll('img')].map(img => getComputedStyle(img).filter),
      numericCells: [...root.querySelectorAll('td')].filter(cell => ['0.25', '0.50'].includes(cell.textContent.trim())).map(cell => getComputedStyle(cell).whiteSpace),
      pageBackground: getComputedStyle(document.documentElement).backgroundColor,
      pageColorScheme: getComputedStyle(document.documentElement).colorScheme,
      controls: root.querySelectorAll('button, aside, mark, .card, .inline-note, .figure-tools, .edited-dot').length,
      en: getComputedStyle(root.querySelector('#print-b-p-edit .en')).display,
      fallback: getComputedStyle(root.querySelector('#print-b-missing .en')).display,
      math: root.querySelectorAll('.katex').length,
      wideMathTex: root.querySelector('#print-b-wide-math annotation').textContent,
      hiddenReader: getComputedStyle(document.getElementById('stage')).display,
      preferences: {...PR.prefs}};
  }, expected);
  fs.writeFileSync(path.join(ARTIFACTS, 'latest-layout-comparison.json'), JSON.stringify({expected, result}, null, 2));
  assert(result.classes.split(' ').includes('mode-' + mode));
  assert(!result.classes.split(' ').includes('zh'), 'Mode is separate from paragraph classes');
  assert.equal(result.color, 'rgb(45, 45, 43)');
  assert.equal(result.background, 'rgb(255, 255, 255)');
  assert.deepEqual(result.type, expected.type, 'Export keeps actual reader typography, including responsive font size');
  assert.deepEqual(result.elements, expected.elements, 'Normal headings, paragraphs, captions, math spacing and three-line tables keep reader styling');
  assert.equal(result.regularTableWrapped, false, 'An ordinary table is not restyled to fit');
  assert.deepEqual(result.blockOrder, expected.blockOrder, 'Figures, tables and formulas keep their position in the content sequence');
  assert(Math.abs(result.width - Math.min(expected.width, 180 * 96 / 25.4)) < 1,
    'Reader content width is kept when it fits, otherwise capped at the printable page width');
  assert.equal(result.fonts, 'loaded');
  assert.equal(result.readyImages, true);
  assert.deepEqual(result.numericCells, ['nowrap', 'nowrap'], 'Numeric table values must not wrap between digits');
  assert(result.imageFilters.every(filter => filter === 'none'), 'Dark reader image filters are absent from print');
  assert.equal(result.pageBackground, 'rgb(255, 255, 255)');
  assert.equal(result.pageColorScheme, 'light');
  assert.equal(result.controls, 0);
  assert.equal(result.en, mode === 'bi' ? 'block' : 'none');
  assert.equal(result.fallback, 'block');
  assert(result.math >= 2, 'KaTeX equations are rendered');
  assert.equal(result.wideMathTex, Array.from({length: 24}, (_, i) => 'x_{' + (i + 1) + '}').join(' + ') + ' = 300',
    'Fitting changes only presentation, preserving the complete equation semantics');
  assert.equal(result.hiddenReader, 'none');
  assert.deepEqual(result.preferences, expected.preferences, 'Export does not change reading preferences or selected reader mode');
  assert.deepEqual(result.overflow, [], 'No horizontal overflow at print width: ' + JSON.stringify(result.overflow));
  return result;
}

async function capturePdf(name, mode) {
  const expected = await readerLayout();
  await page.evaluate(expected => {window.__readerLayout = expected;}, expected);
  const readsBefore = stateReads;
  await page.evaluate(mode => {
    window.__bridgeCall = null;
    window.pywebview = {api: {export_translation_pdf: async filename => {
      window.__bridgeCall = filename;
      return new Promise(resolve => window.__finishBridge = resolve);
    }}};
    window.__exportResult = mode ? PR.exportTranslationPdf(mode) : PR.exportTranslationPdf();
  }, mode);
  await page.locator('.confirm.open').waitFor();
  assert.match(await page.locator('.confirm .cf-body').innerText(), /译文尚不完整/);
  await page.locator('.confirm [data-cf="ok"]').click();
  await page.waitForFunction(() => !!window.__bridgeCall);
  assert.equal(await page.locator('[data-translation-export]').isDisabled(), true);
  assert(stateReads > readsBefore, 'Export freshly reads persisted state');
  assert.match(await page.evaluate(() => window.__bridgeCall), mode === 'bi' ? /-中英对照\.pdf$/ : /-中文译文\.pdf$/);
  await page.emulateMedia({media: 'print'});
  // Chromium print-to-PDF uses the same prepared root and media rules as native WebView2.
  reports[name + '-layout'] = await printLayout(mode || 'zh');
  const file = path.join(ARTIFACTS, name + '.pdf');
  await page.pdf({path: file, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false});
  await page.evaluate(() => window.__finishBridge({status: 'saved'}));
  assert.equal((await page.evaluate(() => window.__exportResult)).status, 'saved');
  await clean(name);
  await page.emulateMedia({media: 'screen'});
  return inspect(file, mode === 'bi');
}

(async () => {
  try {
    const offline = fs.readFileSync(files.offline, 'utf8');
    assert(offline.includes('PR.prepareTranslationPrint'));
    assert(offline.includes('body.translation-print-active'));
    assert(!/<(?:script|link)[^>]+(?:src|href)="\/web\//.test(offline), 'Offline HTML has no external application scripts/styles');
    assert(offline.includes('data:image/webp;base64,'));
    assert(offline.includes('data:font/woff2;base64,'));
    console.log('Synthetic translated paper, persisted edits, images and offline HTML bundling passed.');
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost'), route = url.pathname;
      requests.push({method: req.method, path: route});
      if (route.startsWith('/api/')) {
        let data = {}, status = 200;
        if (route === '/api/p/print-fixture/state') {
          stateReads++; data = clone(state);
          if (stateError) {status = 503; data = {error: 'synthetic state unavailable'};}
        } else if (route === '/api/prefs') data = {reader: {theme: 'dark', mode: 'bi', fs: 28, measure: 50, lh: 2.4}};
        else if (route.endsWith('/versions')) data = {};
        else if (route === '/api/chat/models') data = {models: [], default: ''};
        else if (route.endsWith('/ops')) {
          let body = ''; for await (const part of req) body += part;
          for (const op of JSON.parse(body || '{}').ops || []) {
            if (op.op === 'edit') state.reader.edits[op.block] = {zh: op.zh, at: op.at};
          }
          data = {rev: ++state.reader.rev, versions: {}};
        }
        res.writeHead(status, {'Content-Type': 'application/json'}); return res.end(JSON.stringify(data));
      }
      const assets = route.startsWith('/p/print-fixture/');
      const base = assets ? files.workspace : ROOT;
      const relative = assets ? route.slice('/p/print-fixture/'.length) : route.startsWith('/read/') ? 'reader.html' : route.replace(/^\/web\//, '');
      const file = path.resolve(base, relative);
      if (!file.startsWith(base + path.sep)) {res.writeHead(403); return res.end();}
      try {
        const body = fs.readFileSync(file), ext = path.extname(file);
        res.writeHead(200, {'Content-Type': {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2'}[ext] || 'application/octet-stream'});
        res.end(body);
      } catch {res.writeHead(404); res.end();}
    });
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
    context = await browser.newContext({viewport: {width: 1365, height: 900}, colorScheme: 'dark', serviceWorkers: 'block'});
    await context.tracing.start({screenshots: true, snapshots: true, sources: true});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if ([origin, 'null'].includes(url.origin) || ['data:', 'blob:', 'file:'].includes(url.protocol)) return route.continue();
      external.push(url.href); return route.abort('blockedbyclient');
    });
    await context.addInitScript(() => {
      localStorage.setItem('easyread-prefs', JSON.stringify({theme: 'dark', mode: 'bi', fs: 28, measure: 50, lh: 2.4}));
      localStorage.setItem('easyread-hint-seen', 'true');
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    await page.goto(origin + '/read/print-fixture');
    await page.locator('#b-p-edit').waitFor();
    assert.match(await page.locator('#paper').innerText(), /SAVED_PARAGRAPH/);
    // Deliberately stale reader: export must read this newer disk edit itself.
    state.reader.edits['p-edit'].zh = '保存后的中文段落 LATEST_DISK_PARAGRAPH';
    state.reader.edits['p-edit'].at = '2026-02-01T00:00:00Z';
    await page.evaluate(() => {
      document.getElementById('margin').appendChild(Object.assign(document.createElement('p'), {textContent: 'SIDEBAR_SENTINEL'}));
      document.getElementById('readingTools').appendChild(Object.assign(document.createElement('button'), {textContent: 'CONTROL_SENTINEL'}));
    });
    // Mode dialog defaults to Chinese regardless of the dark bilingual reader.
    await page.locator('[data-translation-export]').click();
    assert.equal(await page.locator('.translation-export-dialog [value="zh"]').isChecked(), true);
    await page.locator('.translation-export-dialog [value="cancel"]').click();
    await page.locator('.translation-export-dialog').waitFor({state: 'detached'});
    await clean('mode-dialog cancel');
    // Cancelling incomplete-translation confirmation performs no export.
    await page.evaluate(() => {window.__cancelResult = PR.exportTranslationPdf();});
    await page.locator('.confirm.open').waitFor();
    await page.screenshot({path: path.join(ARTIFACTS, 'incomplete-translation-warning.png')});
    await page.locator('.confirm [data-cf="no"]').click();
    assert.equal((await page.evaluate(() => window.__cancelResult)).status, 'cancelled');
    await clean('warning cancel');
    reports.chinese = await capturePdf('translated-chinese', null);
    await page.setViewportSize({width: 720, height: 850});
    reports.bilingual = await capturePdf('translated-bilingual', 'bi');
    assert(reports.bilingual.pages > reports.chinese.pages, 'Bilingual export has the full additional source text');
    // Default desktop measure fits on A4 without widening or resetting its type.
    await page.setViewportSize({width: 1365, height: 900});
    await page.evaluate(() => {Object.assign(PR.prefs, {theme: 'light', font: 'serif', mode: 'zh', fs: 18, measure: 35, lh: 1.9}); PR.applyPrefs();});
    await page.screenshot({path: path.join(ARTIFACTS, 'reader-default-serif.png')});
    reports.defaultSerif = await capturePdf('translated-default-serif', 'zh');
    // A narrower sans-serif reader stays narrow, while export mode remains the
    // user's explicit choice even when the current reader only shows Chinese.
    await page.evaluate(() => {Object.assign(PR.prefs, {font: 'sans', fs: 16, measure: 26, lh: 1.5}); PR.applyPrefs();});
    reports.narrowSans = await capturePdf('translated-narrow-sans', 'bi');
    // Browser fallback must not claim success; window.print can be cancelled.
    const fallback = await page.evaluate(async () => {
      delete window.pywebview;
      const confirm = PR.confirm, title = document.title;
      PR.confirm = async () => true;
      window.print = () => {window.__printed = {active: document.body.classList.contains('translation-print-active'),
        title: document.title, roots: document.querySelectorAll('#translationPrint').length};};
      const result = await PR.exportTranslationPdf();
      PR.confirm = confirm;
      return {result, printed: window.__printed, titleRestored: document.title === title};
    });
    assert.equal(fallback.result.status, 'print-dialog');
    assert.deepEqual({active: fallback.printed.active, roots: fallback.printed.roots}, {active: true, roots: 1});
    assert.match(fallback.printed.title, /-中文译文$/);
    assert.equal(fallback.titleRestored, true);
    await clean('browser print dialog');
    // Native cancellation, native failure, missing desktop capability and a thrown print call all clean up.
    for (const variant of ['cancelled', 'error', 'missing-desktop', 'print-throws']) {
      const result = await page.evaluate(async variant => {
        const confirm = PR.confirm; PR.confirm = async () => true;
        if (variant === 'missing-desktop') window.pywebview = {api: {}};
        else if (variant === 'print-throws') {delete window.pywebview; window.print = () => {throw new Error('synthetic print failed');};}
        else window.pywebview = {api: {export_translation_pdf: async () => ({status: variant, error: 'synthetic native failure'})}};
        try {return await PR.exportTranslationPdf();} finally {PR.confirm = confirm; delete window.pywebview;}
      }, variant);
      assert.equal(result.status, variant === 'cancelled' ? 'cancelled' : 'error');
      await clean(variant);
    }
    // A failed fresh-state read must not print stale content.
    stateError = true;
    assert.equal((await page.evaluate(() => PR.exportTranslationPdf())).status, 'error');
    stateError = false;
    await clean('state failure');
    // Reopening bundled offline HTML requires no server or remote resources.
    const offlineState = clone(state);
    fs.writeFileSync(path.join(TEMP, 'library', 'print-fixture', 'reader.json'), JSON.stringify(offlineState.reader));
    // Rebuild to include the newer saved edit through the real build pipeline.
    execFileSync(PYTHON, ['-c', 'from pathlib import Path; from easyread.build import build; from easyread.store import Workspace; import sys; build(Workspace(Path(sys.argv[1])),Path(sys.argv[2]))', files.workspace, files.offline], {env: environment});
    await page.goto(pathToFileURL(files.offline).href);
    await page.locator('#b-p-edit').waitFor();
    assert.equal(await page.evaluate(() => PR.store.mode), 'static');
    const expectedOffline = await readerLayout();
    await page.evaluate(expected => {window.__readerLayout = expected;}, expectedOffline);
    await page.evaluate(async () => {await PR.prepareTranslationPrint(); document.body.classList.add('translation-print-active');});
    await page.emulateMedia({media: 'print'});
    await printLayout('zh');
    const offlinePdf = path.join(ARTIFACTS, 'translated-offline.pdf');
    await page.pdf({path: offlinePdf, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false});
    reports.offline = inspect(offlinePdf, false);
    await page.evaluate(() => {document.getElementById('translationPrint').remove(); document.body.classList.remove('translation-print-active');});
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    assert(!requests.some(req => /translate|ask|chat\/send/.test(req.path)), 'Export makes no translation/model request');
    console.log('Translated PDF Chromium passed: saved edits, list/caption fallback, Chinese/default and bilingual A4 PDFs, images, math/table bounds, missing-page warning, cleanup and offline bundling.');
    console.log(JSON.stringify(reports));
  } catch (error) {failure = error.stack || String(error); throw error;}
  finally {
    if (context) await context.tracing.stop({path: path.join(ARTIFACTS, 'trace.zip')}).catch(() => {});
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(ARTIFACTS, 'result.json'), JSON.stringify({reports, stateReads, errors, external, requests, failure}, null, 2));
    fs.rmSync(TEMP, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
