package io.github.wangrunqiao0915.folioread;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentSender;

import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;

import java.util.ArrayList;
import java.util.List;

/** Native, on-device Google Drive authorization. Never logs or persists tokens. */
public final class GoogleAuthorization {
    public static final int REQUEST_CODE = 6002;
    public static final String DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

    public static final String DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

    public interface Callback {
        void success(String token, List<String> grantedScopes);
        void failure(String message);
    }

    private final Activity activity;
    private final AuthorizationClient client;
    private Callback pending;
    private boolean destroyed;
    private boolean pendingFolderRead;

    public GoogleAuthorization(Activity activity) {
        this.activity = activity;
        this.client = Identity.getAuthorizationClient(activity);
    }

    /** Call only for a user-initiated request from the trusted, main WebView frame. */
    public void authorize(boolean folderImport, Callback callback) {
        if (!BuildConfig.GOOGLE_DRIVE_ENABLED) {
            callback.failure("此测试版尚未启用 Android 云盘授权。完成 Google Cloud 的应用包名与签名 SHA-1 登记后，请安装启用云盘授权的版本。");
            return;
        }
        if (destroyed || activity.isFinishing()) {
            callback.failure("页面已关闭，请重新打开后连接 Google 云盘。");
            return;
        }
        if (pending != null) {
            callback.failure("Google 授权正在进行，请先完成或关闭当前窗口。");
            return;
        }
        if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity)
                != ConnectionResult.SUCCESS) {
            callback.failure("此设备缺少可用的 Google Play 服务，请安装或更新后重试。离线阅读仍可使用。");
            return;
        }
        pending = callback;
        pendingFolderRead = folderImport;
        List<Scope> scopes = new ArrayList<>();
        scopes.add(new Scope(DRIVE_SCOPE));
        if (folderImport) scopes.add(new Scope(DRIVE_READ_SCOPE));
        AuthorizationRequest request = AuthorizationRequest.builder()
                .setRequestedScopes(scopes)
                .setOptOutIncludingGrantedScopes(true)
                .setPrompt(AuthorizationRequest.Prompt.SELECT_ACCOUNT)
                .build();
        client.authorize(request)
                // Do not use Activity-scoped listeners: they are removed onStop,
                // which can strand an in-flight request when the app is interrupted.
                .addOnSuccessListener(result -> {
                    if (destroyed || pending != callback) return;
                    if (result.hasResolution()) {
                        if (result.getPendingIntent() == null) {
                            fail("Google 授权窗口不可用，请重试。");
                            return;
                        }
                        try {
                            activity.startIntentSenderForResult(
                                    result.getPendingIntent().getIntentSender(), REQUEST_CODE,
                                    null, 0, 0, 0);
                        } catch (IntentSender.SendIntentException exception) {
                            fail("Google 授权窗口未能打开，请重试。");
                        }
                    } else {
                        complete(result);
                    }
                })
                .addOnFailureListener(exception -> {
                    if (!destroyed && pending == callback) fail(messageFor(exception));
                });
    }

    /** Forward the Activity result here; true means it belongs to this helper. */
    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CODE) return false;
        if (destroyed || pending == null) return true;
        if (resultCode != Activity.RESULT_OK || data == null) {
            fail("Google 授权已取消；设备上的论文与批注没有改变。");
            return true;
        }
        try {
            complete(client.getAuthorizationResultFromIntent(data));
        } catch (ApiException exception) {
            fail(messageFor(exception));
        }
        return true;
    }

    private void complete(AuthorizationResult result) {
        if (destroyed || pending == null) return;
        String token = result.getAccessToken();
        if (result.getGrantedScopes() == null || !result.getGrantedScopes().contains(DRIVE_SCOPE)
                || (pendingFolderRead && !result.getGrantedScopes().contains(DRIVE_READ_SCOPE))
                || token == null || token.isEmpty()) {
            fail("Google 未授予 Folio Read 所需的云盘文件权限，请重新连接并允许访问。");
            return;
        }
        Callback callback = pending;
        pending = null;
        pendingFolderRead = false;
        callback.success(token, result.getGrantedScopes());
    }

    /** Call after Drive rejects a token with HTTP 401; this does not revoke grants. */
    public void clearToken(String token) {
        if (destroyed || token == null || token.isEmpty()) return;
        client.clearToken(ClearTokenRequest.builder().setToken(token).build());
    }

    /** Call when the local document is replaced or the Activity is destroyed. */
    public void destroy() {
        destroyed = true;
        pending = null;
        pendingFolderRead = false;
    }

    private void fail(String message) {
        pendingFolderRead = false;
        Callback callback = pending;
        pending = null;
        if (callback != null && !destroyed) callback.failure(message);
    }

    private static String messageFor(Exception exception) {
        if (exception instanceof ApiException) {
            int status = ((ApiException) exception).getStatusCode();
            if (status == CommonStatusCodes.CANCELED || status == 12501) {
                return "Google 授权已取消；设备上的论文与批注没有改变。";
            }
            if (status == CommonStatusCodes.DEVELOPER_ERROR) {
                return "Android Google 登录配置尚未匹配。请在原 Google Cloud 项目中登记此 APK 的应用包名和签名 SHA-1。";
            }
            if (status == CommonStatusCodes.NETWORK_ERROR) {
                return "Google 授权网络连接失败，请检查网络后重试。";
            }
            return "Google 授权失败（状态 " + status + "），请检查 Android 客户端配置与网络后重试。";
        }
        return "Google 授权未能完成，请稍后重试。";
    }
}
