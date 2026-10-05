"""Wrap the portable build in an isolated, non-release test package."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
dist = root / 'dist'
launcher = ('@echo off\r\nsetlocal\r\n'
            'set "EASYREAD_HOME=%~dp0test-data"\r\n'
            'set "EASYREAD_LIBRARY=%~dp0test-data\\library"\r\n'
            '"%~dp0FolioRead.exe" --data-dir "%~dp0test-data"\r\n'
            'endlocal\r\n')
readme = '''Folio Read 双功能 Windows 测试包（非正式发布）

1. 将整个 ZIP 解压到一个全新的、可写的独立文件夹。不要覆盖现有程序或资料库。
2. 双击 Start-Isolated-Test.cmd 启动。它将本次测试的数据和文献库固定在包内 test-data 文件夹，忽略环境中原来的资料库设置。
3. 请使用合成 PDF 或自己选择的文献副本测试。不要复制整个旧资料库；不要直接双击 FolioRead.exe。
4. 阅读页“导出 PDF”可以导出已有中文译文或中英对照，不会重新调用翻译模型。
5. 文件菜单“机构访问并导入 PDF（临时会话）”打开独立访问窗口。登录请本人在可信官方页面输入；每次点击“允许下一次 PDF 下载”后下载一篇有权访问的论文。
6. 关闭并清除会话后检查文献库。自动导入不会自动开始付费 AI 翻译。

学校 VPN/SSO/订阅访问还需要用户实际环境验证。CI 只使用合成测试，没有真实学校账号或凭据。
程序未做 Authenticode 签名；若 Windows 阻止运行，请先核对来源和 SHA256，不要关闭安全防护或绕过系统安全警告。
保留 test-data 即保留本次测试文献。正式旧资料库不应被修改。
'''
with zipfile.ZipFile(dist / 'FolioRead-Windows.zip') as source:
    with zipfile.ZipFile(dist / 'FolioRead-Combined-Test-Windows.zip', 'w', zipfile.ZIP_DEFLATED) as target:
        for item in source.infolist():
            target.writestr(item.filename.replace('FolioRead-Windows/', 'FolioRead-Combined-Test/', 1), source.read(item))
        target.writestr('FolioRead-Combined-Test/Start-Isolated-Test.cmd', launcher.encode('ascii'))
        target.writestr('FolioRead-Combined-Test/测试说明.txt', readme.encode('utf-8-sig'))
with zipfile.ZipFile(dist / 'FolioRead-Combined-Test-Windows.zip') as package:
    assert package.testzip() is None
    assert package.read('FolioRead-Combined-Test/Start-Isolated-Test.cmd').decode('ascii') == launcher
print('Isolated combined test package verified')
