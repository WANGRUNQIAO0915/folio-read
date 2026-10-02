# 手机阅读与 Google 云盘同步（测试版）

此功能的代码已加入开发分支。v1.0.0 的 Windows 下载包尚不包含云同步；需完成 Google 授权配置和双端测试后再发布更新。

## iPhone 怎么用

手机端是 PWA。无需 Mac、Apple 开发者账号或 App Store 安装；用 Safari 打开部署后的 HTTPS 手机网址，通过分享菜单选择「添加到主屏幕」。

- 正文单栏阅读，中文 / 英文对照，公式、图表和原页图片。
- 目录、正文查找、字号、浅色 / 深色主题。
- 长按选中文字，四色标注与注记。选字复制仍使用系统菜单。
- 下载后的论文和批注保存在设备内，可离线使用。清除网站数据会删除本机副本，建议定期同步或导出。
- 导入电脑版的**单文件离线 HTML**或手机阅读 JSON。导入只读取数据，不执行 HTML 里的脚本。
- 首版以阅读为主，手机端暂不包含翻译和 AI 问答。本机 CLI 模型无法直接在 iPhone 上运行。

## 两端如何互通

Windows 的「设置 → 云同步」选择论文并同步到 Google Drive 的私有 `Folio Read` 文件夹。手机连接同一账号，文献库显示云端论文，点击后按需下载。两端运行、联网且授权有效时每分钟同步；也可以点击「立即同步」。

Google 云盘容量取决于用户账号；已有付费空间可直接使用。手机仅下载选择的论文。每份阅读文件目前最多 64 MB，包含正文和内嵌原页 / 图表图片；同步包不包含原始 PDF 二进制文件。如需原始 PDF 完整备份，请另外保存到自己的云盘。

同步数据包括论文正文、译文、图表、阅读位置、文字标注、段落注记、论文笔记和人工译文修订。模型 API Key、CLI 登录、机器配置、AI 聊天记录不参与同步。Windows 登录凭据使用当前 Windows 用户的 DPAPI 加密，手机访问令牌仅留在内存中。

同一注记被两台设备同时修改时，会保留另一版本供检查。在笔记中合并需要的内容，再点击「确认采用当前版本」。译文修订、整篇论文笔记和进度以最近时间为准；设备时间应保持准确。没有自动删除云端论文，也没有把资料库设为公开。

手机登录令牌是短期授权，过期后需要点击重新连接。Safari / iOS 限制后台运行，不能承诺手机锁屏后仍持续同步。

## 首次 Google 配置

Google 云盘会员容量与应用登录授权是两项独立配置。使用用户自己的 Google Cloud 项目，启用 Google Drive API，创建同一项目内的两个 OAuth 客户端：

1. **桌面应用**：配置在 Windows 的「设置 → 云同步 → 首次接入配置」。通过系统浏览器登录，使用本机回调和 PKCE。
2. **Web 应用**：为手机静态站配置「已获授权的 JavaScript 来源」，例如 `https://wangrunqiao0915.github.io`。这是 origin，不能包含 `/folio-read/mobile/` 路径。测试时可另外添加 `http://localhost:8784`，预览页面也应使用这个来源。

手机的公开客户端 ID 写入 `easyread/web/mobile/config.json` 的 `google_web_client_id`，或在手机设置中填写。该 ID 是公开应用标识；**网页客户端 Secret、refresh token、账号凭据不得提交仓库**。

OAuth 权限只申请 `https://www.googleapis.com/auth/drive.file`，访问该应用创建或用户明确交给应用的文件。两种客户端必须在同一 Google Cloud 项目，才能共享相同的应用文件权限。Google 登录和实际授权由账号所有者完成。

测试模式需添加测试用户；该模式的桌面 refresh token 通常 7 天过期。公开推广前还需按 Google 的 OAuth 发布与审核要求准备应用说明、主页和隐私信息，不能把“代码可部署”当作“所有人都能登录”。

## 部署

手机阅读测试版地址为 `https://wangrunqiao0915.github.io/folio-read/mobile/`。测试期间，仓库 Pages 从专用 `gh-pages` 分支的根目录发布构建后的静态资源；开发分支保持独立，稳定版 Windows 下载包不变。

后续将功能合入 main 后，可在仓库「Settings → Pages → Source」选择 GitHub Actions。`mobile-pages.yml` 构建并发布仅含静态代码的站点，手机地址仍为 `/folio-read/mobile/`。资料不会随 Pages 发布；应用直接与设备存储、用户自己的 Google Drive 通信。发布资源保留项目与 KaTeX 的许可文本。

本机服务继续只监听 `127.0.0.1`。不要把桌面服务直接开放到公网作为手机后端。

静态构建只复制公开资源，并按内容生成离线缓存版本。新版资源安装后需要关闭所有手机阅读页面，再重新打开；更新不会清除设备中的论文或注记。

## 验证范围

协议测试覆盖重复 / 乱序事件、跨时区、同时修改、删除冲突、手动合并、上传时继续修改、分页、上传失败后的重试、账号隔离和配置排除。浏览器验证覆盖手机尺寸、选字标注、注记持久化、查找和离线启动。

真实 Google 两端同步、真实 iPhone 长按 / 添加主屏幕体验需要在授权配置后检查。完成前以测试版交付，不替换稳定版下载包。

参考：[Google Drive 授权](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[桌面 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[网页 token 模式](https://developers.google.com/identity/oauth2/web/guides/use-token-model)。
