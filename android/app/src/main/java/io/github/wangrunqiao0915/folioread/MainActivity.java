package io.github.wangrunqiao0915.folioread;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A small native shell. Papers remain in the WebView's private IndexedDB. */
public final class MainActivity extends Activity {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String HOME = ORIGIN + "/assets/mobile/index.html";
    private static final int IMPORT_FILE = 6000, EXPORT_FILE = 6001;
    private static final long MAX_EXPORT = 128L * 1024 * 1024;
    private WebView webView;
    private ValueCallback<Uri[]> picker;
    private GoogleAuthorization google;
    private final ExecutorService fileExecutor = Executors.newSingleThreadExecutor();
    private File exportFile;
    private FileOutputStream exportStream;
    private long exportExpected, exportWritten;
    private String exportName, exportMime, exportReplyId;
    private JavaScriptReplyProxy exportReply;
    private boolean exportChoosing;
    private boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        google = new GoogleAuthorization(this);
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.rgb(249, 249, 247));
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        webView = new WebView(this);
        frame.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        // content:// access is required only for user-selected SAF input files.
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isLocal(uri)) {
                    WebResourceResponse response = loader.shouldInterceptRequest(uri);
                    if (response == null) return new WebResourceResponse("text/plain", "UTF-8", 404,
                            "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                    String path = uri.getPath();
                    if (path != null && path.endsWith(".mjs")) response.setMimeType("text/javascript");
                    if (path != null && path.endsWith(".wasm")) response.setMimeType("application/wasm");
                    return response;
                }
                if (!"https".equals(uri.getScheme())) {
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                return null; // HTTPS API requests keep normal TLS/CORS checks.
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                Uri uri = request.getUrl();
                if (isLocal(uri) && "/assets/mobile/index.html".equals(uri.getPath())) return false;
                if (request.hasGesture() && ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
                    catch (ActivityNotFoundException error) { tell("没有可打开此链接的浏览器"); }
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
                if (!isTrustedPage()) { callback.onReceiveValue(null); return true; }
                cancelPicker();
                picker = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES,
                                new String[]{"application/pdf", "application/json", "text/html", "text/plain"})
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivityForResult(intent, IMPORT_FILE); }
                catch (ActivityNotFoundException error) { cancelPicker(); tell("请安装或启用系统文件选择器"); }
                return true;
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "FolioNative", Collections.singleton(ORIGIN),
                    (view, message, sourceOrigin, isMainFrame, reply) -> {
                        if (!isMainFrame || !ORIGIN.equals(sourceOrigin.toString()) || !isTrustedPage()) return;
                        handleMessage(message.getData(), reply);
                    });
        }
        webView.loadUrl(HOME);
    }

    private boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }
    private boolean isTrustedPage() {
        String url = webView.getUrl();
        return url != null && isLocal(Uri.parse(url)) && "/assets/mobile/index.html".equals(Uri.parse(url).getPath());
    }

    private void handleMessage(String raw, JavaScriptReplyProxy reply) {
        String id = "";
        try {
            if (raw == null || raw.length() > 70000) throw new IllegalArgumentException("请求过大");
            JSONObject message = new JSONObject(raw);
            id = message.getString("id");
            if (!id.matches("[0-9]{1,12}")) return;
            String action = message.getString("action");
            final String requestId = id;
            switch (action) {
                case "authorizeDrive":
                    if (!BuildConfig.GOOGLE_DRIVE_ENABLED) {
                        throw new IllegalStateException("此测试包尚未启用 Google 授权。请先登记应用 ID 与签名 SHA-1，再构建启用云盘的安装包。");
                    }
                    google.authorize(message.optBoolean("folderImport", false), new GoogleAuthorization.Callback() {
                        @Override public void success(String token, List<String> grantedScopes) {
                            try { respond(reply, new JSONObject().put("id", requestId).put("ok", true).put("token", token)
                                    .put("grantedScopes", new JSONArray(grantedScopes))); }
                            catch (Exception error) { MainActivity.this.failure(reply, requestId, "Google 授权结果不可用"); }
                        }
                        @Override public void failure(String message) { MainActivity.this.failure(reply, requestId, message); }
                    });
                    return;
                case "clearDriveToken":
                    google.clearToken(message.optString("token", ""));
                    break;
                case "exportBegin":
                    if (exportFile != null) throw new IllegalStateException("请先完成或取消当前导出");
                    exportExpected = message.getLong("size");
                    if (exportExpected < 0 || exportExpected > MAX_EXPORT) throw new IllegalArgumentException("导出文件超过 128 MB");
                    exportMime = message.optString("mime");
                    if (!"application/pdf".equals(exportMime) && !"application/json".equals(exportMime))
                        throw new IllegalArgumentException("不支持此导出格式");
                    exportName = message.optString("name", "folio-export").replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
                    if (exportName.length() > 140) exportName = exportName.substring(0, 140);
                    if (exportName.trim().isEmpty()) exportName = "folio-export";
                    exportFile = File.createTempFile("folio-export-", ".tmp", getCacheDir());
                    exportStream = new FileOutputStream(exportFile);
                    exportWritten = 0;
                    break;
                case "exportChunk":
                    if (exportStream == null || exportChoosing) throw new IllegalStateException("没有待写入的导出");
                    byte[] chunk = Base64.decode(message.getString("data"), Base64.NO_WRAP);
                    if (chunk.length > 48 * 1024 || exportWritten + chunk.length > exportExpected)
                        throw new IllegalArgumentException("导出大小不匹配");
                    exportStream.write(chunk);
                    exportWritten += chunk.length;
                    break;
                case "exportFinish":
                    if (exportStream == null || exportChoosing || exportWritten != exportExpected)
                        throw new IllegalStateException("导出尚未完整写入");
                    exportStream.close(); exportStream = null;
                    exportReply = reply; exportReplyId = id; exportChoosing = true;
                    try {
                        startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT)
                                .addCategory(Intent.CATEGORY_OPENABLE).setType(exportMime)
                                .putExtra(Intent.EXTRA_TITLE, exportName), EXPORT_FILE);
                    } catch (ActivityNotFoundException error) { cleanupExport(); throw new IllegalStateException("系统文件保存功能不可用"); }
                    return;
                case "exportCancel":
                    if (!exportChoosing) cleanupExport();
                    break;
                default: throw new IllegalArgumentException("不支持此操作");
            }
            respond(reply, new JSONObject().put("id", id).put("ok", true));
        } catch (Exception error) {
            failure(reply, id, error.getMessage() == null ? "操作未完成" : error.getMessage());
        }
    }

    private void respond(JavaScriptReplyProxy reply, JSONObject result) {
        if (!destroyed && isTrustedPage()) reply.postMessage(result.toString());
    }
    private void failure(JavaScriptReplyProxy reply, String id, String error) {
        try { respond(reply, new JSONObject().put("id", id).put("ok", false).put("error", error)); }
        catch (Exception ignored) { /* Page or activity may have closed. */ }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (google.onActivityResult(requestCode, resultCode, data)) return;
        if (requestCode == IMPORT_FILE) {
            ValueCallback<Uri[]> callback = picker; picker = null;
            if (callback == null) return;
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            callback.onReceiveValue(uri != null && "content".equals(uri.getScheme()) ? new Uri[]{uri} : null);
        } else if (requestCode == EXPORT_FILE && exportReply != null) {
            JavaScriptReplyProxy reply = exportReply; String id = exportReplyId;
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (uri == null || !"content".equals(uri.getScheme())) {
                try { respond(reply, new JSONObject().put("id", id).put("ok", true).put("cancelled", true)); }
                catch (Exception ignored) { }
                cleanupExport(); return;
            }
            final File file = exportFile;
            fileExecutor.execute(() -> {
                String error = null;
                try (FileInputStream input = new FileInputStream(file);
                     OutputStream output = getContentResolver().openOutputStream(uri, "w")) {
                    if (output == null) throw new IllegalStateException("无法打开保存位置");
                    byte[] buffer = new byte[64 * 1024]; int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                } catch (Exception exception) { error = "保存失败，请检查空间和文件权限后重试"; }
                final String failure = error;
                runOnUiThread(() -> {
                    if (failure != null) failure(reply, id, failure);
                    else try { respond(reply, new JSONObject().put("id", id).put("ok", true)); }
                    catch (Exception ignored) { }
                    cleanupExport();
                });
            });
        }
    }

    private void cancelPicker() { if (picker != null) { picker.onReceiveValue(null); picker = null; } }
    private void cleanupExport() {
        try { if (exportStream != null) exportStream.close(); } catch (Exception ignored) { }
        if (exportFile != null) exportFile.delete();
        exportFile = null; exportStream = null; exportReply = null; exportReplyId = null; exportChoosing = false;
    }
    private void tell(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    @Override public void onBackPressed() {
        webView.evaluateJavascript("Boolean(window.FolioPlatform && window.FolioPlatform.onBack && window.FolioPlatform.onBack())",
                result -> { if (!"true".equals(result)) moveTaskToBack(true); });
    }
    @Override protected void onPause() { webView.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }
    @Override protected void onDestroy() {
        destroyed = true; cancelPicker(); cleanupExport(); fileExecutor.shutdown();
        if (google != null) google.destroy();
        if (webView != null) { webView.stopLoading(); webView.destroy(); }
        super.onDestroy();
    }
    WebView getReaderWebView() { return webView; }
}
