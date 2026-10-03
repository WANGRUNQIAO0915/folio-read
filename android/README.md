# Folio Read Android 测试版

基于 `feat/mobile-google-drive` 的 `1a67b2e`，复用现有移动阅读、批注、检索、PDF 导入与 IndexedDB 数据格式。Android 原生外壳以 `WebViewAssetLoader` 提供本地 HTTPS 资源，内置 PDF.js、worker、CMaps、字体、WASM 和 KaTeX。无需首次联网下载阅读组件，不依赖电脑版运行。

## 安装与范围

在 GitHub Actions 的 **Android test APK** 工作流中下载 `folio-read-android-debug`，解压后安装 `folio-read-0.1.0-test.apk`。这是自签名调试测试包，尚未在 Google Play 发布。Android 8.0（API 26）以上，需可用且较新的 Android System WebView。PDF.js 6.x 以 Chromium 125+ 为支持基线；旧版 WebView 可能无法解析 PDF。

- 系统文件选择器导入 PDF、阅读 JSON 或 HTML，无需广泛存储权限。
- 正文、原页缩略图、目录、检索、笔记、字号、主题和本地保存复用移动端。
- 设置中导出当前论文为 `.folio.json`；原页中导出完整 PDF。系统保存对话框取消时不报告成功。阅读备份不包含原始 PDF，需分别导出。
- Google 云盘已接入官方原生授权代码；配置和真实设备授权/双向同步仍需验证，不能把构建通过当作登录成功。
- AI 沿用自行配置的 HTTPS/CORS API，未经真实服务验证；默认密钥仅在本次页面内存中。勾选保存后存于本应用 IndexedDB，不进入阅读备份或云同步。
- 扫描 PDF 不包含 OCR。复杂版式、公式与表格提取的限制与移动版相同。PDF 最多 128 MB、300 页。

清除应用数据或卸载会删除本机论文与笔记；导出备份后再做。自动云备份关闭，防止本机保存的 API 配置进入 Android 备份。Android 应用的数据与浏览器/PWA 数据互相独立。

## Google 原生授权配置

测试包应用 ID：`io.github.wangrunqiao0915.folioread.debug`。命名空间/非调试 application ID：`io.github.wangrunqiao0915.folioread`。

构建产物的 `signing-certificate.txt` 记录**该 APK** 的真实签名证书 SHA-1/SHA-256，`SHA256SUMS.txt` 可校验 APK，`build-info.txt` 记录源码提交和开关。在与电脑端/Web 端相同的 Google Cloud 项目中：

1. 启用 Drive API；检查 OAuth 同意屏幕和测试用户。
2. 添加 **Android OAuth 客户端**，填入上述调试应用 ID 与此 APK 的签名 SHA-1。
3. 在有 Google Play 服务的真实设备安装该 APK，点击连接。普通连接只请求 `drive.file`。新源码另有「授权并启用自动导入」入口，在说明后额外请求 `drive.readonly`；Google 授权允许读整个云盘，应用只扫描 Folio Read 文件夹直接包含的 PDF。需要在同一项目的 OAuth 同意屏幕声明只读范围并由用户实际同意，代码改动不表示已经授权。返回的权限逐项验证；令牌只在内存中，遇到 401 清除 Google 缓存后要求重新授权。

文件夹导入的原稿保留、兼容副本与容量说明见 [共同云端资料库](../docs/mobile-sync.md#直接把-pdf-放进云盘文件夹)。只有包含此源码的新安装包才有新增入口，先前交付 APK 不会自动获得它。

默认工作流产出已含原生授权入口的 APK，登记**这一个 APK**的应用 ID/SHA-1 后可直接用同一包重试，无需重编译。未登记时会显示配置错误。没有创建 OAuth 客户端、扩展云账号权限、嵌入 API Key/secret/refresh token，或声称已完成真实账号验证。

每次 CI 的默认 debug 密钥可能不同，**不要拿一个构建的 SHA-1 去登记另一个构建**。新签名包也不能直接覆盖旧安装；卸载会丢本地资料。长期升级、稳定发布和持续 Google 登录需要用户批准后配置固定签名方案。本仓库和 Actions 产物不上传签名私钥。

可用 `-PenableGoogleDrive=false` 构建明确禁用授权的纯本地测试包。

## 构建

需要 JDK 17、Android SDK Platform 35、Build Tools 35.0.0、Python 3.10+ 和 Node 22。若 SDK 尚未安装，开发者需先查看并接受 Google SDK 条款。本项目不会代替你运行自动同意许可命令。

```sh
npm ci --prefix android/web --ignore-scripts --omit=optional
python -m unittest discover -s tests -p 'test_android*.py' -v
node tests/test_android_drive.cjs
cd android
./gradlew --no-daemon lintDebug assembleDebug assembleDebugAndroidTest
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。使用官方 Gradle 8.11.1 wrapper（分发 SHA-256 固定）、AGP 8.9.2、SDK 35、AndroidX WebKit 1.12.1 和 Play Services Auth 22.0.0。

原生安全界限：远程网页不在内嵌 WebView 中导航；普通外链由系统浏览器处理；不启用 `file://` 或通用文件权限。桥接采用限定 HTTPS origin 的 `WebMessageListener`，只接收本地顶层页面的固定操作，无通用 JS/URL 执行入口。HTML 导入仍按数据解析，不执行其中脚本。

## 自动检查与尚需验证

`tests/test_android_build.py` 检查白名单资源、PDF.js 全套离线依赖、资源哈希、许可证与原生安全配置；`tests/test_android_drive.cjs` 覆盖原生 token 桥接、取消、超时、401、重复请求及网页回退。保留全部原移动端测试。

Android CI 构建/lint 并上传 APK，然后在 Android 15 模拟器关闭 Wi-Fi/移动数据进行：首次启动、实际 PDF.js/worker 解析、原稿 IndexedDB 保存、笔记、Activity 重建后重新读取、返回关闭弹层、原生文件选择回调连续取消、系统保存回调取消。测试文件通过 WebView 的 File/input 处理器注入；系统选取器返回值通过 instrumentation 模拟。它不代表已完成真实文件提供者/真机交互/进程被系统杀死/Google 账号/任意模型 API 验证。

若运行器已有 KVM 访问权限则使用它；否则无加速回退，可能因超时未验证，不修改系统权限。

发布前真机还需：系统文件应用选择 PDF（含中文）、文件提供者 MIME 差异、较大 PDF 的内存、强制结束后恢复、选字标注、旋转、导出再导入、外链、Google 取消/重试/双向同步及账号隔离。

## 第三方来源

- [PDF.js 6.3.289 / pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist/v/6.3.289)：npm lockfile 固定版本与 integrity，构建时仅复制 legacy core/worker、CMaps、standard_fonts、WASM 及 Apache-2.0 LICENSE。
- 上游 Folio Read MIT 许可与 KaTeX 许可保留在安装包资源中。
- [Android 本地 WebView 内容](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [Google 原生授权](https://developer.android.com/identity/authorization)
- [Google OAuth 原生应用与嵌入式浏览器政策](https://developers.google.com/identity/protocols/oauth2/policies)
