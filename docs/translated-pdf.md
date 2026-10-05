# 导出译文 PDF

[返回项目首页](../README.md) · [开发说明](development.md)

阅读页顶栏选择「导出 PDF」。默认导出中文译文，也可选择「逐段中英对照」。导出使用已有译文和保存后的修改，不调用翻译模型，不改动原始 PDF。

## 保存方式

- **Windows 桌面版**：选择保存位置，应用通过 WebView2 生成 PDF。取消保存不会显示成功；出错会保留原文件并显示原因。
- **网页或单文件离线 HTML**：打开浏览器打印窗口，选择「另存为 PDF」。浏览器打印窗口关闭不代表保存成功，应用不会据此提示「已保存」。建议关闭浏览器页眉、页脚，并保留 A4 纸张设置。
- **其他桌面平台**：原生 PDF 保存面向 Windows / WebView2；不支持的桌面后端会明确报错。可使用网页模式的浏览器打印。

## 输出内容

- 固定 A4 白底排版，不受深色主题、阅读字号、侧栏或当前中英显示偏好影响。
- 正文、标题、列表项和图表说明采用当前译文修改；公式、表格、参考文献和可用图片保留。
- 缺少译文时保留对应原文或原页，并在导出前及 PDF 内提示不完整。图片不可用时尝试原页回退，无法取得原页则明确标注缺图。
- 阅读笔记、AI 边注、划线、高亮、工具栏和侧栏不会写入译文 PDF。
- 正在编辑的内容需先保存或取消。网页模式会读取最新保存的数据；仍在浏览器待存队列中的修改会明确提示。
- 导出前等待字体和图片就绪。PDF 是重新排版的译文，不保证与出版社原 PDF 的版面或页码一一对应；特别复杂的公式和表格请核对原文。

## 回归验证

使用完全合成的论文和本地图像，无真实文献、账号、API Key 或模型请求。

```sh
python -m pip install .
npm install --prefix /tmp/folio-playwright --no-save --package-lock=false playwright@1.58.2 jsdom@26.1.0
/tmp/folio-playwright/node_modules/.bin/playwright install --with-deps chromium
# Linux 建议安装 fonts-noto-cjk，避免中文字体缺字。
node tests/test_translation_store.cjs
PLAYWRIGHT=/tmp/folio-playwright/node_modules/playwright node tests/test_translation_print.cjs
```

Windows 可将 `/tmp/folio-playwright` 替换为临时目录，并通过 PowerShell 的 `$env:PLAYWRIGHT` 设置模块路径。已安装应用的 Python 可通过 `PYTHON` 指定，系统 Chromium 可通过 `CHROMIUM_EXECUTABLE` 指定。

- `test_translation_store.cjs`：刷新时的持久化、并发保存和撤销覆盖。
- `test_translation_print.cjs`：真实 Chromium 生成中文、对照、离线 PDF；用 Python 解析多页文字与图像、检查 A4 页边界和空白页，并渲染每页 PNG 留作视觉检查。包含窄窗口、深色阅读偏好、宽公式/表格、缺译提示和失败恢复。原生桥接在此测试中模拟，不能替代 Windows 测试。
- Windows 原生集成测试与工作流另行覆盖 WebView2 / `PrintToPdfAsync`。Windows EXE 发布前仍应人工检查文件对话框、取消、覆盖确认和生成文件。

浏览器测试的 PDF、逐页 PNG、检查结果、截图、trace 和日志保存在 `tests/shots/translation-print/`，或 `BROWSER_ARTIFACTS` 指定的目录；CI 会上传这些结果。运行环境无法启动 Chromium 时，测试会失败，不会把未执行的 PDF 验证记为通过。
