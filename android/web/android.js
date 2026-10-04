/* Android adapter. Native messages are restricted to this local top-level origin. */
(function () {
  'use strict';
  const waiting = new Map();
  let sequence = 0;
  if (window.FolioNative) window.FolioNative.onmessage = event => {
    let result;
    try { result = JSON.parse(event.data); } catch (_) { return; }
    if (!result || typeof result !== 'object') return;
    const job = waiting.get(result.id);
    if (!job) return;
    clearTimeout(job.timer); waiting.delete(result.id);
    if (result.ok) job.resolve(result); else job.reject(new Error(result.error || '操作未完成'));
  };
  function request(action, details = {}) {
    if (!window.FolioNative) return Promise.reject(new Error('请更新 Android System WebView 后重试。'));
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('操作已超时，请重试。')); }, 600000);
      waiting.set(id, {resolve, reject, timer});
      try { window.FolioNative.postMessage(JSON.stringify({id, action, ...details})); }
      catch (error) { clearTimeout(timer); waiting.delete(id); reject(error); }
    });
  }
  let saving = false;
  window.FolioPlatform = {
    native: true,
    bundledAssets: true,
    pdfBase: new URL('../vendor/pdfjs/', location.href).href,
    authorizeDrive: async (options = {}) => {
      const result = await request('authorizeDrive', {folderImport: options.folderImport === true});
      return {token: result.token, grantedScopes: Array.isArray(result.grantedScopes) ? result.grantedScopes : []};
    },
    clearDriveToken: token => request('clearDriveToken', {token}),
    async saveBlob(blob, name) {
      if (saving) throw new Error('请先完成或取消当前导出。');
      if (blob.size > 128 * 1024 * 1024) throw new Error('导出文件不能超过 128 MB。');
      saving = true;
      try {
        await request('exportBegin', {name, mime: blob.type, size: blob.size});
        for (let offset = 0; offset < blob.size; offset += 48 * 1024) {
          const bytes = new Uint8Array(await blob.slice(offset, offset + 48 * 1024).arrayBuffer());
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          await request('exportChunk', {data: btoa(binary)});
        }
        const result = await request('exportFinish');
        return !result.cancelled;
      } catch (error) {
        request('exportCancel').catch(() => {});
        throw error;
      } finally { saving = false; }
    }
  };
})();
