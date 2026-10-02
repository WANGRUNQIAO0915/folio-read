# 开发说明

[返回项目首页](../README.md) · [更新记录](../CHANGELOG.md) · [数据格式](data-format.md)

需要 Python 3.10 或更新版本。Windows 桌面交付已验证；其他平台可尝试网页模式，桌面体验尚未验证。

## 从源码运行

在 PowerShell 中：

```powershell
git clone https://github.com/WANGRUNQIAO0915/folio-read.git
cd folio-read
python -m venv .venv
.venv\Scripts\python.exe -m pip install ".[desktop]"
.venv\Scripts\python.exe desktop_launcher.py
```

只使用网页模式时，可不安装桌面依赖：

```sh
python -m pip install .
python -m easyread serve --port 8766 --open
```

项目保留 `easyread` Python 包名及命令作为兼容入口，产品名称为 Folio Read。也可使用安装后提供的 `folio-read` 或 `folio` 命令。

从源码目录运行时，数据默认写入该目录。可用 `EASYREAD_HOME` 指定数据目录，用 `EASYREAD_LIBRARY` 指定文献库；勿将本机配置或个人资料提交到仓库。

## 构建 Windows EXE

在干净的虚拟环境内安装构建依赖，避免将无关组件打包。

```sh
python -m pip install ".[windows-build]"
python scripts/build_windows.py
```

输出位于 `dist/`，包含单文件 EXE、MIT 与第三方许可说明。独立窗口使用 pywebview / WebView2，EXE 不包含模型本体或外部 CLI。

## 验证

```sh
python -m unittest discover tests
node tests/test_chat_export.cjs
node tests/test_markup_links.cjs
```

涉及桌面行为的变更还应使用实际 EXE 检查启动、重复启动、关闭退出和保存对话框；阅读工具变更应检查跨段 / 英文标注、注记保存、重开恢复、查找、撤销和复制到其他软件。README 和图片变更只需检查链接、内容与 GitHub 展示。

## 提交问题与改进

提交 Issue 时说明应用版本、操作系统、复现步骤、预期与实际结果。截图和日志请先去除 API Key、个人文献及其他隐私信息。

提交 Pull Request 时说明解决的问题、最终行为与相关验证。保持上游 MIT 许可与出处。
