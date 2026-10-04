<div align="center">

<img src="easyread/web/favicon.svg" width="64" alt="Folio Read 标志">

# Folio Read

**读论文，做笔记，向自己的资料库提问。**

A desktop paper reader with translation, annotations, and personal-library Q&A.

[![Windows 下载](https://img.shields.io/badge/Windows-Download-cc7d5e?logo=windows&logoColor=white)](https://github.com/WANGRUNQIAO0915/folio-read/releases/latest/download/FolioRead-Windows.zip)
[![版本](https://img.shields.io/github/v/release/WANGRUNQIAO0915/folio-read?color=6c7467)](https://github.com/WANGRUNQIAO0915/folio-read/releases/latest)
[![MIT](https://img.shields.io/badge/License-MIT-777777)](LICENSE)

[下载应用](https://github.com/WANGRUNQIAO0915/folio-read/releases/latest/download/FolioRead-Windows.zip) · [使用与快捷键](docs/reading-tools.md) · [反馈问题](https://github.com/WANGRUNQIAO0915/folio-read/issues)

</div>

Folio Read 是一款以阅读为中心的 Windows 桌面应用：把英文论文整理为可阅读的中文正文，对照原文看图表、标注和记笔记，再让 AI 根据当前论文或收藏的资料库回答问题。文献与笔记保存在本机，翻译和问答可连接你自己的模型服务。

本项目基于 [EasyRead](https://github.com/Edwardxlai/easyread) 开发，保留上游 MIT 许可证与原作者版权声明。

iPhone 测试版支持独立导入 PDF、阅读、批注和资料库检索。手机与 Windows 通过自己的 Google Drive 共享完整 PDF、正文、译文和笔记，任意一端上传后，另一端同步即可看到；手机可单独配置 DeepSeek 等 API 用于翻译和问答。[打开手机版](https://wangrunqiao0915.github.io/folio-read/mobile/) · [同步与安装说明](docs/mobile-sync.md)。源码测试版还支持在明确授权后，同步时自动导入直接放进 Folio Read 云盘文件夹的 PDF；两种入口按文件内容去重，不自动调用 AI。稳定版 v1.0.0 下载包尚不包含这些测试功能。

测试版还加入了 easyScholar 期刊分区查询和正文参考文献预览。电脑版在「设置 → 期刊分区」填写个人 SecretKey；密钥只保存在本机，查询结果可同步到手机。点击编号或作者—年份引用可查看条目、跳到文末及打开已有 DOI。详见[期刊与引用说明](docs/journal-and-citations.md)。

## 界面预览

![Folio Read 阅读界面：中文正文、原文对照、标注工具栏与文内查找](docs/images/folio-read-reader.jpg)

*实际应用截图，展示 DPO 示例论文的中文阅读与查找。浅色、深色及跟随系统主题均可使用。*

## 下载与开始使用

目前提供 **Windows 桌面版**，无需安装 Python。

1. [下载 FolioRead-Windows.zip](https://github.com/WANGRUNQIAO0915/folio-read/releases/latest/download/FolioRead-Windows.zip)，解压到一个可写入的文件夹。
2. 双击 `FolioRead.exe`，打开独立应用窗口。
3. 在设置中配置翻译与问答模型，再导入 PDF 或 arXiv 论文。
4. 开始翻译和阅读；选中文字可复制、标注或写注记，打开「陪读」即可提问。

桌面窗口依赖微软 WebView2 Runtime。Windows 10 / 11 通常已具备；缺少时可从 [微软官方页面](https://developer.microsoft.com/microsoft-edge/webview2/) 安装。

应用免费开源，**不附带模型或 API 额度**。AI 功能的费用和可用性取决于你连接的服务。完整发布文件与校验信息见 [Releases](https://github.com/WANGRUNQIAO0915/folio-read/releases)。

## 能做什么

| 使用场景 | 功能 |
| --- | --- |
| **读懂一篇论文** | 后台翻译、中文与英文对照、原 PDF 页面查看；正文配图、点击放大和手动框选；译文中的网站与 DOI 链接可点击。 |
| **留下阅读痕迹** | 选中文字复制到其他软件；四色荧光笔、下划线、跨段标注与注记；文内查找、撤销和阅读进度。 |
| **用目录导航** | 合并跨页重复标题，按章节层级展开／收起，标出当前章节及原文页码；宽屏目录与正文并排，窄屏跳转后收起。 |
| **围绕原文提问** | 对当前论文提问，生成论文概览、章节与页精读，解读图表和公式；回答附引文、页码与原文定位入口。 |
| **用收藏建立知识库** | 管理文献分类；向全部收藏或指定分类提问，可纳入个人笔记；区分论文依据、笔记与 AI 的库外补充。 |
| **整理共同研究问题** | 比较 2–8 篇论文，保存研究主题、证据与待核实问题；导出 Markdown、Obsidian 笔记、RIS 和离线阅读文件。 |

### 向整个资料库提问

在「知识问答 → 问资料库」中选择全部收藏或一个分类，也可以在阅读页的陪读面板切换当前论文 / 整个资料库。

例如：

> 这些论文如何衡量城市绿地的降温效果？方法和研究尺度有什么差异？

应用会检索收藏论文和可选的个人笔记，把相关片段交给你选择的模型，并提供引用定位。资料不足时，可允许模型补充通用知识，库外补充会单独标出。

检索使用有容量限制的相关片段，**未命中不代表整个库中没有相关内容**。引用便于核对依据，仍需检查原文是否支持回答。

## 连接自己的模型

| 连接方式 | 需要准备 |
| --- | --- |
| DeepSeek 或其他兼容 API | 服务地址、模型名称、自己的 API Key。 |
| 本机推理服务 | 已启动的、提供兼容 API 的服务及模型；按服务要求填写认证信息。 |
| Codex / Claude CLI | 在电脑上安装并登录相应 CLI，应用调用其模型配置。 |

「本机已配置」不等于模型一定在本地推理。Codex / Claude CLI 和远端 API 会将任务材料发送至对应服务；如果需要本地处理，请连接在本机运行的推理服务。

## 阅读操作

拖选或双击选词后，按 `Ctrl+C` 复制，到其他软件按 `Ctrl+V` 粘贴。正文顶部的工具栏也提供复制、荧光笔、下划线和注记入口。

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+F` | 查找当前页面；`Enter` / `Shift+Enter` 切换结果。 |
| `Ctrl+Shift+H` / `Ctrl+Shift+U` | 给选中文字加荧光笔 / 下划线。 |
| `Ctrl+Shift+N` | 为选区或当前段添加注记。 |
| `Ctrl+Z` | 在正文中撤销本次新建标注；在文本框中撤销编辑。 |
| `Esc` | 退出连续标注模式，返回文字选择。 |

颜色选择、连续标注及操作范围见 [完整阅读工具说明](docs/reading-tools.md)。

## 数据与备份

文献、模型配置、标注、笔记和研究记录保存在本机。独立使用 EXE 时，通常会在程序旁创建「FolioRead数据」文件夹；通过「文件 → 打开数据文件夹」可查看实际位置。备份时保存整个数据文件夹。

已有「Folio数据」「EasyRead数据」或程序旁的 `easyread-personal` 目录时，应用会沿用现有数据。仓库与发布包不包含个人文献、笔记或认证信息；本机 `config.json` 可能包含 API Key，请勿上传。

## 当前限制

- 当前发布包面向 Windows；macOS / Linux 桌面体验尚未验证。
- 原 PDF 页面以图片展示；文字选择、复制和标注用于中文正文及对照英文。
- 自动配图依赖可识别的 PDF 图像边界；复杂矢量图或扫描页可能需要手动框选。
- Zotero 已提供本机条目搜索与关联入口，需要开启本机 API；该连接尚未完成实机验证。

## 开发与贡献

想从源码运行、构建 EXE 或参与开发，见 [开发说明](docs/development.md)。发现问题可提交 [Issue](https://github.com/WANGRUNQIAO0915/folio-read/issues)，请附版本、复现步骤及去除个人信息后的截图。功能建议和 Pull Request 也欢迎。

如果 Folio Read 对你有用，可以在仓库右上角点 **Star**，方便以后找到项目。

## 来源与许可证

Folio Read 基于 [Edwardxlai/easyread](https://github.com/Edwardxlai/easyread) 开发，保留上游 [MIT License](LICENSE) 与 [原版说明](docs/UPSTREAM-README.md)。在此基础上增加了个人资料库问答、研究主题、阅读工具与 Windows 桌面交付，并调整了阅读界面。本项目与上游无官方关联。

上游基线提交：`9e2feee99578c520ac2d0fd056e80bbee33bd897`。

### 文献文件夹与 AI 分类

在软件内创建文件夹、导入时选位置，之后批量移动论文并添加多个标签；原始 PDF 保持不变。AI 分类先显示接收服务和待发送片段，明确同意后生成建议，检查确认后再保存。文件夹与标签随共享资料库同步。详见[分类使用说明](docs/library-organization.md)。

### 中文名称与 PDF 下载名

可单篇或批量核对论文中文名称，并将它用于软件显示与下载原 PDF 的文件名。先提供本地标题建议；需要 AI 翻译时先确认接收服务与发送文本，生成后仍需检查并确认应用。AI 翻译会注明并非官方中文题名，保留原题和原文件名，不改动云盘原 PDF。详见[中文名称使用说明](docs/chinese-pdf-names.md)。
