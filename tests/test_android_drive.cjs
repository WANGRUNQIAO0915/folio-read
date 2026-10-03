'use strict';

// Exercises the real Android JS bridge plus the native branch of drive.js.
// Native Google UI still requires device testing and registered package/SHA-1.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const adapter = fs.readFileSync(path.join(root, 'android/web/android.js'), 'utf8');
const drive = fs.readFileSync(path.join(root, 'easyread/web/mobile/drive.js'), 'utf8');
const TEST_TOKEN = 'synthetic-native-test-token';

function harness(options = {}) {
  const messages = [], requests = [], timers = new Map();
  let nextTimer = 0;
  const state = { token: TEST_TOKEN, error: null, unauthorized: false, autoReply: true };
  const window = {
    FolioMobile: {},
    FolioStorage: {setting() { throw new Error('Login must not persist credentials'); }}
  };
  const reply = value => window.FolioNative.onmessage({data: JSON.stringify(value)});
  if (!options.noBridge) window.FolioNative = {
    postMessage(text) {
      const message = JSON.parse(text);
      messages.push(message);
      if (!state.autoReply) return;
      queueMicrotask(() => {
        if (message.action === 'authorizeDrive') {
          reply(state.error ? {id: message.id, ok: false, error: state.error}
            : {id: message.id, ok: true, token: state.token});
        } else if (message.action === 'clearDriveToken') {
          reply({id: message.id, ok: true});
        } else {
          reply({id: message.id, ok: false, error: 'Unexpected action'});
        }
      });
    }
  };
  const context = vm.createContext({
    window, URL, URLSearchParams,
    location: {href: 'https://appassets.androidplatform.net/assets/mobile/index.html'},
    document: {createElement() { throw new Error('Android login must not load Google GIS'); }},
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, settings) => {
      requests.push({url, settings});
      assert.equal(settings.headers.Authorization, 'Bearer ' + TEST_TOKEN);
      if (state.unauthorized) return {ok: false, status: 401};
      if (url.includes('/about?')) return {ok: true, json: async () => ({
        user: {permissionId: 'test-account', emailAddress: 'test@example.invalid'}
      })};
      return {ok: true, json: async () => ({files: []})};
    }
  });
  vm.runInContext(adapter, context, {filename: 'android/web/android.js'});
  vm.runInContext(drive, context, {filename: 'easyread/web/mobile/drive.js'});
  return {D: window.FolioDrive, P: window.FolioPlatform, window, state,
    messages, requests, timers, reply};
}

(async () => {
  {
    const h = harness();
    await h.D.loadIdentity();
    assert.equal(h.messages.length, 0);
    assert.equal(h.requests.length, 0);
    const user = await h.D.login('');
    assert.equal(user.permissionId, 'test-account');
    assert.equal(h.D.connected, true);
    assert.equal(h.D.account.emailAddress, 'test@example.invalid');
    assert.equal(h.messages[0].action, 'authorizeDrive');
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0].url, /\/drive\/v3\/about\?fields=user/);
    assert.equal(h.timers.size, 0);
    await h.D.list();
    h.state.unauthorized = true;
    await assert.rejects(h.D.list(), /Google 登录已过期/);
    const cleared = h.messages.find(message => message.action === 'clearDriveToken');
    assert.equal(cleared.token, TEST_TOKEN);
    assert.equal(h.D.connected, false);
    assert.equal(h.D.account, null);
    h.state.unauthorized = false;
    await h.D.login('browser-client-id-is-not-needed');
    assert.equal(h.D.connected, true);
    h.D.logout();
    assert.equal(h.D.connected, false);
    assert.equal(h.D.account, null);
  }
  {
    const h = harness();
    h.state.error = 'Google 授权已取消';
    await assert.rejects(h.D.login(''), /授权已取消/);
    assert.equal(h.D.connected, false);
    assert.equal(h.D.account, null);
    assert.equal(h.requests.length, 0);
    h.state.error = 'Android 客户端尚未配置';
    await assert.rejects(h.D.login(''), /客户端尚未配置/);
    assert.equal(h.requests.length, 0);
    h.state.error = null;
    await h.D.login('');
    assert.equal(h.D.connected, true);
  }
  for (const invalidToken of ['', null, undefined, 'contains whitespace']) {
    const h = harness();
    h.state.token = invalidToken;
    await assert.rejects(h.D.login(''), /有效登录凭据/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.D.connected, false);
  }
  {
    const h = harness();
    h.state.autoReply = false;
    const first = h.D.login('');
    await assert.rejects(h.D.login(''), /授权正在进行/);
    assert.equal(h.messages.length, 1);
    h.window.FolioNative.onmessage({data: 'not valid JSON'});
    h.reply({id: 'unknown-request-id', ok: true, token: TEST_TOKEN});
    assert.equal(h.timers.size, 1);
    h.reply({id: h.messages[0].id, ok: true, token: TEST_TOKEN});
    await first;
    assert.equal(h.timers.size, 0);
    assert.equal(h.D.connected, true);
  }
  {
    const h = harness();
    h.state.autoReply = false;
    const timedOut = h.D.login('');
    const rejected = assert.rejects(timedOut, /超时/);
    const timeout = h.timers.values().next().value;
    timeout();
    await rejected;
    h.reply({id: h.messages[0].id, ok: true, token: TEST_TOKEN});
    assert.equal(h.D.connected, false);
    assert.equal(h.requests.length, 0);
    h.state.autoReply = true;
    await h.D.login('');
    assert.equal(h.D.connected, true);
  }
  {
    const h = harness({noBridge: true});
    await assert.rejects(h.D.login(''), /Android System WebView/);
    assert.equal(h.D.connected, false);
    assert.equal(h.requests.length, 0);
  }
  console.log('Android native Drive adapter: account handshake, client-ID independence, no GIS/credential persistence, 401 invalidation, cancel/setup failure, invalid tokens, concurrent login, message correlation, timeout/retry, and missing bridge passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
