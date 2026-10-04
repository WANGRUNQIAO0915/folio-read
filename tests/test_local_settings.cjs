const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const dialog = {addEventListener() {}};
const PR = {$: selector => selector === '#settingsDlg' ? dialog : null, $$: () => [], settingsTabs: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/common/settings.js'), 'utf8'), {window: {PR}, document: {addEventListener() {}}});
const presets = [
  {id: 'lmstudio', group: 'local', base_url: 'http://127.0.0.1:1234/v1', model: 'default-8b'},
  {id: 'llamacpp', group: 'local', base_url: 'http://127.0.0.1:8080/v1', model: 'qwen3.8-27b-q6k-dflash2', vision: true, reasoning_effort: 'none'},
];
function state() {
  return {tab: 'engine', presets, cfg: {engine: 'openai', concurrency: 1, batch_pages: 1,
    claude: {}, codex: {}, openai: {preset: 'lmstudio', base_url: 'http://127.0.0.1:1234/v1', model: 'custom-27b', vision: true}}};
}
function event(selector, data) {return {target: {closest: query => query === selector ? {dataset: data} : null}};}
(async () => {
  const current = state();
  await PR.settingsTabs.engine.click(event('[data-preset]', {preset: 'lmstudio'}), current);
  assert.equal(current.cfg.openai.model, 'custom-27b');
  assert.equal(current.cfg.openai.vision, true);
  await PR.settingsTabs.engine.click(event('[data-engine]', {engine: 'free'}), current);
  assert.equal(current.cfg.concurrency, 1);
  current.cfg.concurrency = 3;
  await PR.settingsTabs.engine.click(event('[data-preset]', {preset: 'llamacpp'}), current);
  assert.equal(current.cfg.concurrency, 1);
  assert.equal(current.cfg.openai.vision, true);
  assert.equal(current.cfg.openai.reasoning_effort, 'none');
  console.log('Local model settings regressions passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
