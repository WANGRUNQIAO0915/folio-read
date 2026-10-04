# Folio Read Android

Folio Read Android 使用原生 WebView 外壳，复用移动端的阅读、批注、检索、PDF 导入及 IndexedDB 数据格式。`WebViewAssetLoader` 提供本地 HTTPS 资源，安装包内置 PDF.js、worker、CMaps、字体、WASM 和 KaTeX，阅读组件无需首次联网下载，也不依赖桌面端运行。

[项目首页](../README.md) · [共享资料库](../docs/mobile-sync.md) · [文献组织](../docs/library-organization.md) · [中文名称](../docs/chinese-pdf-names.md)

## 交付状态

Android 外壳与共享移动端源码已合入 `main`，包含文件夹、AI 分类及中文名称功能。Windows v1.1.0-test.2 发布未提供对应的 Android APK；已有安装包不随源码更新。构建与 lint 已验证；模拟器运行、真机 Google 授权、双向同步及升级安装尚未完成验证。

APK 交付与持续升级要求见[签名、升级与备份](#签名升级与备份)。

## 测试安装与功能范围

开发测试可在 GitHub Actions 的 **Android test APK** 工作流中，选择所需源码提交且构建成功的运行，下载 `folio-read-android-debug`，解压后安装 `folio-read-0.1.0-test.apk`。这是自签名调试测试包，尚未在 Google Play 发布。Android 8.0（API 26）以上，需可用且较新的 Android System WebView。PDF.js 6.x 以 Chromium 125+ 为支持基线；旧版 WebView 可能无法解析 PDF。

- 系统文件选择器导入 PDF、阅读 JSON 或 HTML，无需广泛存储权限。
- 正文、原页缩略图、目录、检索、笔记、字号、主题和本地保存复用移动端。逻辑文件夹、标签与中文显示名属于元数据，不会移动原 PDF 或重命名云盘原文件；导出原 PDF 时可使用已确认的中文名称。
- 设置中导出当前论文为 `.folio.json`；原页中导出完整 PDF。系统保存对话框取消时不报告成功。阅读备份不包含原始 PDF，需分别导出。
- Google 云盘采用官方原生授权接口；真实设备授权与双向同步尚未验证。
- AI 沿用自行配置的 HTTPS/CORS API，未经真实服务或分类 / 译名质量验证。分类与名称翻译在展示接收服务和发送文本、取得明确同意后发起请求，经人工确认后保存；AI 译名标注为非官方中文题名。API Key 默认仅存于当前页面内存。勾选保存后存于本应用 IndexedDB，不进入阅读备份或云同步。
- 扫描 PDF 不包含 OCR。复杂版式、公式与表格提取的限制与移动版相同。PDF 最多 128 MB、300 页。

## Google 原生授权配置

测试包应用 ID：`io.github.wangrunqiao0915.folioread.debug`。命名空间/非调试 application ID：`io.github.wangrunqiao0915.folioread`。

构建产物的 `signing-certificate.txt` 记录**该 APK** 的真实签名证书 SHA-1/SHA-256，`SHA256SUMS.txt` 可校验 APK，`build-info.txt` 记录源码提交和开关。在与电脑端/Web 端相同的 Google Cloud 项目中：

1. 启用 Drive API；检查 OAuth 同意屏幕和测试用户。
2. 添加 **Android OAuth 客户端**，填入上述调试应用 ID 与此 APK 的签名 SHA-1。
3. 在有 Google Play 服务的真实设备安装该 APK，点击连接。普通连接只请求 `drive.file`。「授权并启用自动导入」入口会在说明后额外请求 `drive.readonly`；Google 授权允许读整个云盘，应用只扫描 Folio Read 文件夹直接包含的 PDF。需要在同一项目的 OAuth 同意屏幕声明只读范围并由用户实际同意，代码改动不表示已经授权。返回的权限逐项验证；令牌只在内存中，遇到 401 清除 Google 缓存后要求重新授权。

文件夹导入的原稿保留、兼容副本与容量说明见 [共同云端资料库](../docs/mobile-sync.md#直接把-pdf-放进云盘文件夹)。

默认工作流构建包含原生授权入口的 APK。为**该 APK** 登记应用 ID 与签名 SHA-1 后，可使用原包重试授权；未登记时可能返回配置错误。OAuth 客户端与授权范围需在同一 Google Cloud 项目中配置，安装包不内置 API Key、secret 或 refresh token。

可用 `-PenableGoogleDrive=false` 构建禁用原生授权的纯本地测试包。

## 签名、升级与备份

- CI 默认 debug 签名可能随构建变化，Google OAuth 必须登记目标 APK 的签名 SHA-1。
- 覆盖升级要求应用 ID 与签名匹配。签名不同的包无法覆盖旧安装；持续升级和稳定发布需采用固定签名方案。签名私钥不得提交到仓库或作为 Actions 产物上传。
- 清除应用数据或卸载会删除本机论文与笔记。操作前应分别导出阅读备份与原 PDF；阅读 JSON 不包含原 PDF，卸载重装不保证无损迁移。
- Android 应用与浏览器 / PWA 使用独立的数据存储。系统自动云备份已关闭，避免本机保存的 API 配置进入 Android 备份。

## 构建

需要 JDK 17、Android SDK Platform 35、Build Tools 35.0.0、Python 3.10+ 和 Node 22。使用 Android SDK 前须阅读并接受相应许可条款。在仓库根目录执行：

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

`tests/test_android_build.py` 检查白名单资源、PDF.js 全套离线依赖、资源哈希、许可证与原生安全配置；`tests/test_android_drive.cjs` 覆盖原生 token 桥接、取消、超时、401、重复请求及网页回退。同时运行共享移动端回归测试。

Android CI 包含构建、lint、产物上传及 Android 15 模拟器测试步骤。模拟器测试设计覆盖断网条件下的首次启动、PDF.js / worker 解析、原稿 IndexedDB 保存、笔记、Activity 重建后读取、返回关闭弹层，以及文件选择和系统保存回调取消；实际完成情况以具体工作流结果为准。测试文件通过 WebView 的 File/input 处理器注入，系统选取器返回值由 instrumentation 模拟；真实文件提供者、系统终止进程后的恢复、Google 账号及真实模型 API 不在此模拟范围内。

模拟器使用运行器现有的 KVM 访问权限；不可用时采用无加速模式，可能导致启动或测试超时。

真机验收应覆盖系统文件选择器与中文 PDF、文件提供者 MIME 差异、大文件内存占用、强制结束后恢复、选字标注、屏幕旋转、导出与再导入、外链，以及 Google 授权取消、重试、双向同步和账号隔离。

## 第三方来源

- [PDF.js 6.3.289 / pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist/v/6.3.289)：npm lockfile 固定版本与 integrity，构建时仅复制 legacy core/worker、CMaps、standard_fonts、WASM 及 Apache-2.0 LICENSE。
- 上游 Folio Read MIT 许可与 KaTeX 许可保留在安装包资源中。
- [Android 本地 WebView 内容](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [Google 原生授权](https://developer.android.com/identity/authorization)
- [Google OAuth 原生应用与嵌入式浏览器政策](https://developers.google.com/identity/protocols/oauth2/policies)
