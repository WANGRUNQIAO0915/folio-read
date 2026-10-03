// Real Chromium regression, with a generated PDF and no credentials/model calls.
// Install the Python package first. Then install playwright@1.58.2 and its
// Chromium browser, and run: node tests/test_browser.cjs
// Optional: PYTHON, PLAYWRIGHT (module path), BROWSER_ARTIFACTS (output directory).
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const PYTHON = process.env.PYTHON || 'python';
const SUPPORT = path.join(__dirname, 'browser_support.py');
const TITLE = 'Folio Offline Regression Fixture';
const ARTIFACTS = path.resolve(process.env.BROWSER_ARTIFACTS || path.join(__dirname, 'shots', 'browser'));
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-browser-'));
const HOME = path.join(TEMP, 'home');
const LIBRARY = path.join(HOME, 'library');
const PDF = path.join(TEMP, 'offline-fixture.pdf');
fs.mkdirSync(LIBRARY, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });
for (const name of ['server.log', 'network-guard.jsonl']) fs.writeFileSync(path.join(ARTIFACTS, name), '');

// Do not inherit API keys, agent configuration, or personal data directories.
const env = {};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LD_LIBRARY_PATH', 'VIRTUAL_ENV']) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, {
  HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: HOME, APPDATA: HOME,
  EASYREAD_HOME: HOME, EASYREAD_LIBRARY: LIBRARY,
  PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
});
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  engine: 'none', auto_translate: false,
  claude: { command: 'folio-ci-disabled-cli' },
  codex: { command: 'folio-ci-disabled-cli' },
  openai: { base_url: '', api_key: '', model: '' },
}));

let server, browser, context, page, url, pid;
let session = 0;
const browserLog = [], errors = [], httpErrors = [], blockedRequests = [];
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const disk = (name) => JSON.parse(fs.readFileSync(path.join(LIBRARY, pid, name + '.json'), 'utf8'));
const log = (message) => { console.log(message); browserLog.push(message); };

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error('Timed out: ' + label + (lastError ? '\n' + lastError.message : ''));
}

async function startServer() {
  server = spawn(PYTHON, [SUPPORT, 'serve', path.join(ARTIFACTS, 'network-guard.jsonl')], {
    cwd: TEMP, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', spawnError;
  server.on('error', error => { spawnError = error; });
  server.stdout.on('data', data => { output += data; fs.appendFileSync(path.join(ARTIFACTS, 'server.log'), data); });
  server.stderr.on('data', data => fs.appendFileSync(path.join(ARTIFACTS, 'server.log'), data));
  await until(() => {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error('Server exited: ' + server.exitCode);
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) { url = match[0]; return true; }
    return false;
  }, 'application server startup');
  log('Server started at ' + url);
}

async function stopServer() {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const stopped = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
  await stopped;
  clearTimeout(timer);
}

async function newContext() {
  session += 1;
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, colorScheme: 'light', serviceWorkers: 'block',
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  // Any accidental cross-origin request fails before leaving the browser.
  await context.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === url || ['data:', 'blob:'].includes(requestUrl.protocol)) return route.continue();
    blockedRequests.push(requestUrl.href);
    return route.abort('blockedbyclient');
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => {
    browserLog.push('console.' + message.type() + ': ' + message.text());
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', response => {
    if (response.status() >= 400) httpErrors.push(response.status() + ' ' + response.url());
  });
  page.on('requestfailed', request => browserLog.push('requestfailed: ' + request.url() + ' ' + JSON.stringify(request.failure())));
}

async function closeContext() {
  if (!context) return;
  await context.tracing.stop({ path: path.join(ARTIFACTS, 'trace-' + session + '.zip') });
  await context.close();
  context = null;
}

const shot = name => page.screenshot({ path: path.join(ARTIFACTS, name + '.png'), fullPage: true });
const row = () => page.locator('#list .row[data-id="' + pid + '"]');
const waitText = (selector, text) => page.waitForFunction(
  ({ selector, text }) => document.querySelector(selector)?.textContent.trim() === text,
  { selector, text },
);

async function importPdf() {
  await page.locator('#importBtn').click();
  await page.locator('#importDlg.open').waitFor();
  assert.equal(await page.locator('#autoTr').isChecked(), false, 'automatic translation is off');
  assert.equal(await page.locator('#autoTr').isDisabled(), true, 'no engine is configured');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#pick').click();
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/import' && r.request().method() === 'POST');
  await (await chooser).setFiles(PDF);
  const imported = await response;
  assert.equal(imported.status(), 200, 'PDF import succeeds');
  assert.equal(new URL(imported.url()).searchParams.get('translate'), '0', 'import does not request translation');
  await page.locator('#importDlg.open').waitFor({ state: 'hidden' });
  // Chromium can evict upload responses from its inspector cache, including
  // before response.json() is read. Verify the user-visible result and real
  // persisted bytes below instead of depending on CDP response-body retention.
  await row().waitFor();
  await waitText('#count', '1 篇');
  assert.equal(page.url(), url + '/', 'import remains in the library');
  assert.equal(await page.locator('#list .row').count(), 1, 'one fixture row is listed');
  assert.deepEqual(fs.readdirSync(LIBRARY, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name),
  [pid], 'exactly one workspace exists, identified by the uploaded PDF hash');
}

async function search(query, expectedCount) {
  const response = page.waitForResponse(r => {
    const u = new URL(r.url());
    return u.pathname === '/api/search' && u.searchParams.get('q') === query;
  });
  await page.locator('#q').fill(query);
  const result = await response;
  assert.equal(result.status(), 200);
  await waitText('#count', expectedCount + ' 篇');
  assert.equal(await page.locator('#list .row').count(), expectedCount);
  if (expectedCount) assert.match(await row().locator('.search-hit').innerText(), /Offline Regression/);
  else assert.match(await page.locator('#list .empty-state').innerText(), /没有符合条件的论文/);
}

async function setStatus(status, label) {
  await row().click();
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/p/' + pid + '/item' && r.request().method() === 'POST');
  await page.locator('#detail [data-status="' + status + '"]').click();
  assert.equal((await response).status(), 200, 'status save succeeds');
  await row().locator('.pill.' + status).waitFor();
  await waitText('#list .row[data-id="' + pid + '"] .pill', label);
  await page.locator('#detail [data-status="' + status + '"].on').waitFor();
  assert.equal(disk('item').status, status, 'status is written to item.json');
}

async function openReader() {
  await row().click();
  await page.locator('#detail a[href="/read/' + pid + '"]').click();
  await page.waitForURL(url + '/read/' + pid);
  await waitText('#paper h1', TITLE);
  await page.locator('#orig-1 img').waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('#orig-1 img');
    return img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
  });
  assert.equal(await page.locator('#paper .orig-page').count(), 2, 'both original PDF pages render');
  assert.ok(disk('item').last_opened, 'opening the reader persists last_opened');
}

(async () => {
  try {
    execFileSync(PYTHON, [SUPPORT, 'fixture', PDF], { cwd: TEMP, env });
    const pdf = fs.readFileSync(PDF);
    pid = crypto.createHash('sha256').update(pdf).digest('hex').slice(0, 12);
    await startServer();
    browser = await chromium.launch({ headless: true });
    await newContext();
    await page.goto(url + '/');
    await waitText('#count', '0 篇');
    assert.equal(await page.locator('#list .row').count(), 0, 'test starts with an empty library');

    // Cancelling and reopening must leave the import button functional.
    await page.locator('#importBtn').click();
    await page.locator('#importDlg.open').waitFor();
    await page.locator('#impClose').click();
    await page.locator('#importDlg.open').waitFor({ state: 'hidden' });
    assert.equal(fs.existsSync(path.join(LIBRARY, pid)), false, 'fixture is not already imported');
    await importPdf();
    assert.equal(await row().locator('.t1').innerText(), TITLE);
    await row().locator('.pill.unread').waitFor();
    await until(() => disk('job').state === 'done', 'local PDF rendering and extraction', 30000);
    assert.equal(disk('job').type, 'prepare');
    assert.equal(disk('paper').meta.page_count, 2);
    assert.deepEqual(fs.readFileSync(path.join(LIBRARY, pid, 'source.pdf')), pdf);
    assert.match(fs.readFileSync(path.join(LIBRARY, pid, 'extract', 'page-001.txt'), 'utf8'), /Synthetic page 1/);
    log('PASS: import dialog, generated PDF upload, local extraction, and library listing');

    const originallyAdded = disk('item').added;
    await importPdf();
    assert.equal(disk('item').added, originallyAdded, 'repeat import preserves the existing item');
    assert.deepEqual(fs.readFileSync(path.join(LIBRARY, pid, 'source.pdf')), pdf);
    await search('Offline Regression', 1);
    await shot('01-library-search');
    await search('missing-fixture-zzzzzz', 0);
    await page.locator('#q').fill('');
    await waitText('#count', '1 篇');
    log('PASS: duplicate import, matching search, empty search, and cleared search');

    await setStatus('reading', '在读');
    await shot('02-reading-status');
    await openReader();
    await shot('03-reader-original');
    await page.locator('[data-act="pages"]').click();
    await page.locator('body.pv-open').waitFor();
    await waitText('.pv-label', '第 1 / 2 页');
    await page.locator('[data-pv="next"]').click();
    await waitText('.pv-label', '第 2 / 2 页');
    await page.waitForFunction(() => {
      const img = document.querySelector('.pv-page img');
      return img?.src.includes('page-002') && img.complete && img.naturalWidth > 0;
    });
    await shot('04-reader-page-two');
    await page.locator('[data-pv="close"]').click();
    await page.locator('body.pv-open').waitFor({ state: 'hidden' });
    await page.locator('#backBtn').click();
    await page.waitForURL(url + '/');
    await row().locator('.pill.reading').waitFor();
    await setStatus('done', '已读');
    log('PASS: reader navigation, actual PDF images, page controls, and reading-status saves');

    // Both the server and context are new: persistence cannot come from JS state,
    // an in-memory backend cache, localStorage, or a browser HTTP cache.
    await closeContext();
    await stopServer();
    await startServer();
    await newContext();
    await page.goto(url + '/');
    await waitText('#count', '1 篇');
    await row().locator('.pill.done').waitFor();
    assert.equal(await row().locator('.t1').innerText(), TITLE);
    await search('Offline Regression', 1);
    await page.locator('#q').fill('');
    await waitText('#count', '1 篇');
    await openReader();
    await shot('05-reader-after-restart');
    await page.locator('#backBtn').click();
    await row().locator('.pill.done').waitFor();
    assert.equal(disk('item').status, 'done', 'completed status survives reopening the reader');
    await shot('06-library-after-restart');
    log('PASS: status, title, search, and original PDF survive backend restart and fresh browser context');

    assert.deepEqual(errors, [], 'no browser runtime/console errors');
    assert.deepEqual(httpErrors, [], 'no failing HTTP responses or missing frontend assets');
    assert.deepEqual(blockedRequests, [], 'the browser requests no external resources');
    const guardFile = path.join(ARTIFACTS, 'network-guard.jsonl');
    const guarded = fs.existsSync(guardFile) ? fs.readFileSync(guardFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    // Ollama model-list discovery happens on startup, but the guard prevents
    // even this local probe. No other network or subprocess attempt is expected.
    const unexpected = guarded.filter(entry => entry.event !== 'socket.connect' ||
      JSON.stringify(entry.target) !== JSON.stringify(['127.0.0.1', 11434]));
    assert.deepEqual(unexpected, [], 'no model CLI or external backend network attempts');
    log('ALL CHROMIUM REGRESSIONS PASS');
  } catch (error) {
    process.exitCode = 1;
    log(error.stack || String(error));
    if (page && !page.isClosed()) {
      await shot('failure').catch(() => {});
      fs.writeFileSync(path.join(ARTIFACTS, 'failure.html'), await page.content().catch(() => ''));
    }
  } finally {
    if (pid) {
      for (const name of ['item', 'paper', 'reader', 'job']) {
        const file = path.join(LIBRARY, pid, name + '.json');
        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(ARTIFACTS, name + '.json'));
      }
    }
    await closeContext().catch(error => { process.exitCode = 1; log('Trace/cleanup failure: ' + error.message); });
    if (browser) await browser.close();
    await stopServer();
    fs.writeFileSync(path.join(ARTIFACTS, 'browser.log'), browserLog.join('\n') + '\n');
    fs.writeFileSync(path.join(ARTIFACTS, 'errors.json'), JSON.stringify({ errors, httpErrors, blockedRequests }, null, 2));
    if (fs.existsSync(path.join(HOME, 'easyread.log'))) fs.copyFileSync(path.join(HOME, 'easyread.log'), path.join(ARTIFACTS, 'application.log'));
    fs.rmSync(TEMP, { recursive: true, force: true });
    console.log('Artifacts: ' + ARTIFACTS);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
