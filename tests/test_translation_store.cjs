'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const clone = value => JSON.parse(JSON.stringify(value));
(async () => {
  const saved = { edits: {}, notes: {} };
  const local = { op: 'edit', block: 'p1', zh: '刚保存的修改', at: '2026-10-05T01:00:00Z' };
  const ack = deferred(), state = deferred();
  let loaded = false, getState = false;
  const PR = { uid: () => 'c1', nowIso: () => '2026-10-05T00:00:00Z', emit() {},
    ls: { get: () => [clone(local)], set: () => true } };
  const initial = { paper: { meta: {} }, reader: clone(saved), versions: {} };
  const context = { window: { PR, addEventListener() {} }, document: { getElementById: () => null, hidden: false },
    location: { pathname: '/read/test-paper' }, setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    fetch: async (url, options = {}) => {
      if (url.endsWith('/ops')) { await ack.promise; return { ok: true, json: async () => ({ rev: 1 }) }; }
      if (url.endsWith('/state')) {
        if (!loaded) { loaded = true; return { ok: true, json: async () => clone(initial) }; }
        getState = true; await state.promise; return { ok: true, json: async () => clone(initial) };
      }
      throw new Error(url);
    } };
  vm.runInNewContext(fs.readFileSync('easyread/web/js/reader/store.js', 'utf8'), context);
  await PR.load();
  const saving = PR.flush();
  const exporting = PR.refreshForExport();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getState, true);
  ack.resolve(); await saving;
  assert.equal(PR.store.pending, 0);
  state.resolve(); await exporting;
  assert.equal(PR.state.reader.edits.p1.zh, local.zh, 'stale state must not erase just-acknowledged edit');
  PR.commit({ op: 'edit', block: 'p1', zh: null, at: '2026-10-05T02:00:00Z' });
  await PR.refreshForExport();
  assert.equal(PR.state.reader.edits.p1.reverted, true, 'revert must not resurrect saved translation');
  PR.commit({ op: 'note', note: { id: 'n1', body: 'saved note', updated: '2026-10-05T03:00:00Z' } });
  PR.commit({ op: 'paper_note', body: 'saved paper note', at: '2026-10-05T03:00:00Z' });
  PR.commit({ op: 'progress', block: 'p9', ratio: .8, at: '2026-10-05T03:00:00Z' });
  await PR.flush();
  await PR.refreshForExport();
  assert.equal(PR.state.reader.notes.n1.body, 'saved note');
  assert.equal(PR.state.reader.paper_note.body, 'saved paper note');
  assert.equal(PR.state.reader.progress.block, 'p9');
  PR.commit({ op: 'note_del', id: 'n1', at: '2026-10-05T04:00:00Z' });
  PR.commit({ op: 'paper_note', body: '', at: '2026-10-05T04:00:00Z' });
  await PR.flush(); await PR.refreshForExport();
  assert.equal(PR.state.reader.notes.n1.deleted, true);
  assert.equal(PR.state.reader.paper_note.body, '');
  console.log('Translation snapshot: in-flight save/state race and reverted edit preserved');
})().catch(error => { console.error(error); process.exitCode = 1; });
