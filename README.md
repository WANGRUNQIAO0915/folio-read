# Folio Read

基于 [Edwardxlai/easyread](https://github.com/Edwardxlai/easyread) 的个人阅读版本，以论文正文阅读为主，按需展开陪读工具。

## 功能

- 译文链接：网站、DOI、邮箱和 Markdown 链接可点击；已有文章可恢复 PDF 的网页链接，无需重译。无法精确对应的地址保留在折叠的原文链接列表中。
- Absolutely 配色：暖白 / 炭灰与陶土橙，支持浅色、深色、跟随系统与离线导出。
- 阅读优先布局：导航按阅读、文献库、知识问答、研究主题排列；题头信息可展开并直达摘要或正文，陪读先提问，模型用齿轮选择，历史与主题收集置后。文献列表分别显示阅读百分比与翻译页数；实际阅读自动标为在读，手动未读与已读状态仍可控制。
- 阅读界面升级：文献分类、独立问答历史、折叠引文与继续提问；主题列表直接查看研究记录，小窗口与深色模式适配。
- 知识库问答：自动检索全部收藏论文或指定分类，支持个人笔记；论文引文、个人笔记和模型库外补充分开标注，阅读页可切换当前论文 / 整个资料库。
- 正文自动配图、点击放大、在原页上重新框选；截图重开和重译后保留，离线阅读版包含图片。
- 导入 PDF / arXiv 论文、后台翻译、原文对照、划线与笔记。
- 有原文依据的全文问答，回答附页码、引文和定位链接。
- 论文概览、章节与页精读；图表、公式解读和原图框选。
- 围绕共同问题比较 2–8 篇论文。
- 研究主题、证据记录与待核实问题；Markdown、Obsidian、RIS 导出。
- Windows 独立应用窗口；阅读界面使用嵌入式 WebView2，双击启动，关闭窗口退出。

Zotero 提供本机条目搜索与关联入口，需要开启 Zotero 本机 API；该连接尚未完成实机验证。

## Windows 使用

下载发布版本中的 `FolioRead-Windows.zip`，解压后双击 `FolioRead.exe`。无需安装 Python。
独立窗口需要微软 WebView2 Runtime；Windows 10 / 11 通常已具备，缺少时从 [微软官方页面](https://developer.microsoft.com/microsoft-edge/webview2/) 安装。

EXE 放在已有 `easyread-personal` 目录旁时可沿用文献与配置；单独放进新文件夹，会创建旁边的「FolioRead数据」空库；已有「Folio数据」或「EasyRead数据」时继续沿用。
「文件 → 打开数据文件夹」可查看实际数据位置。模型配置、文献、笔记和研究记录保存在程序外部。

## 从源码运行

需要 Python 3.10 或更新版本；桌面窗口仅在 Windows 验证。

```sh
python -m venv .venv
# Windows
.venv\Scripts\python.exe -m pip install ".[desktop]"
.venv\Scripts\python.exe desktop_launcher.py
```

需要网页形式时：

```sh
python -m pip install .
python -m easyread serve --port 8766 --open
```

## 模型

设置中选择本机已安装并登录的 Codex / Claude，或 DeepSeek、其他兼容 API、本机推理服务。
EXE 不包含模型本体或 CLI。远端模型会接收你提交的翻译或分析材料。

## 构建 Windows EXE

建议在全新的虚拟环境内安装构建依赖，避免将无关组件打包。

```sh
python -m pip install ".[windows-build]"
python scripts/build_windows.py
```

输出位于 `dist/`，包含单文件 EXE、MIT 与第三方许可说明。

## 验证

```sh
python -m unittest discover tests
node tests/test_chat_export.cjs
node tests/test_markup_links.cjs
```

当前桌面交付完成 81 项 Python 测试，以及实际 EXE 的窗口、PDF 导入/渲染/抽取、笔记持久化、重复启动、系统保存对话框和退出检查。
AI 回答需要回到原文核对；引文存在不等于结论一定正确。

## 数据与隐私

仓库与发布程序排除 API Key、CLI 认证、本机配置、个人文献、笔记、研究记录和界面缓存。
本机 `config.json` 可能保存你填写的 API Key，请勿提交到仓库。备份阅读资料时保存整个数据目录。

## 来源与许可证

保留上游 [MIT License](LICENSE)，基线提交为 `9e2feee99578c520ac2d0fd056e80bbee33bd897`。
原版说明保存在 [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md)。本版本与上游无官方关联。

自动配图优先使用 PDF 的真实图像对象边界；复杂矢量图或扫描页缺少可靠边界时，可用“框选图片”补上。图表在深色模式保留原始颜色。
