"""The diagnostic-only job must reuse PR4 APKs and retain evidence on failure."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/diagnose_android_candidate.sh'


class CandidateDiagnosticTest(unittest.TestCase):
    def test_workflow_pins_both_apks_without_building_or_distributing(self):
        text = (ROOT / '.github/workflows/android-pr4-diagnostics.yml').read_text()
        for required in ('run-id: 37123181013', "branches: ['diag/drive-import-android-crash']",
                         "github.event_name == 'push' && github.ref == 'refs/heads/diag/drive-import-android-crash'",
                         '1007ef91add794f2a36ee12d2d7662c2b30d11d93f0d152426a8ca7355177244',
                         '7d4e9fb7667727fe250d99de4a364f8e70e548a78b001917315498e0d4dbdeb9',
                         'path: pr4-diagnostics/', 'if: always()', 'retention-days: 3'):
            self.assertIn(required, text)
        self.assertNotIn('gradlew', text)
        self.assertNotIn('assembleDebug', text)
        self.assertNotIn('apksigner', text)
        self.assertIn('NOT the APK delivered earlier', text)
        self.assertNotIn('pull_request:', text)
        self.assertNotIn('workflow_dispatch:', text)
        self.assertNotIn('schedule:', text)
        # This is a dedicated branch push, not a new commit on PR4. PR path
        # filters are cumulative, so filename-only isolation would be incorrect.
        for name in ('android.yml', 'android-delivered-smoke.yml'):
            existing = (ROOT / '.github/workflows' / name).read_text()
            self.assertNotRegex(existing, r'(?m)^  push:')
        for name in ('test.yml', 'mobile-pages.yml'):
            existing = (ROOT / '.github/workflows' / name).read_text()
            self.assertRegex(existing, r'(?m)^  push:\n    branches: \[main\]$')

    @unittest.skipIf(os.name == 'nt', 'Diagnostic shell runs on the Linux emulator runner')
    def test_failure_keeps_full_logs_and_nonzero_result(self):
        bash = shutil.which('bash')
        if not bash:
            self.skipTest('bash unavailable')
        fake_adb = r'''#!/bin/sh
printf '%s\n' "$*" >> "$ADB_LOG"
case "$*" in
  'install '*|'shell svc wifi disable') exit 0 ;;
  'shell service check phone') echo 'Service phone: not found' ;;
  'shell settings get global wifi_on') echo 0 ;;
  'shell dumpsys connectivity')
    if [ "$SCENARIO" = online ]; then echo 'Active default network: 100'; else echo 'Active default network: none'; fi ;;
  'shell am instrument '*)
    case "$SCENARIO" in
      process_crash) echo 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.'; echo 'INSTRUMENTATION_CODE: 0'; exit 0 ;;
      transport_failure) echo 'adb transport failed' >&2; exit 21 ;;
      *) echo 'OK (1 test)' ;;
    esac ;;
  'logcat -b all -d -v threadtime') echo 'full system native process evidence' ;;
  'logcat -b crash -d -v threadtime') echo 'crash evidence' ;;
  'shell dumpsys activity exit-info '*) echo 'ApplicationExitInfo fixture' ;;
  'shell dumpsys webviewupdate') echo 'WebView fixture' ;;
  *) echo "Unexpected adb command: $*" >&2; exit 99 ;;
esac
'''
        for scenario, expected in [('success', 0), ('process_crash', 1), ('transport_failure', 21), ('online', 1)]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); binary = root / 'bin'; binary.mkdir()
                (binary / 'adb').write_text(fake_adb); (binary / 'adb').chmod(0o755)
                (binary / 'sleep').write_text('#!/bin/sh\nexit 0\n'); (binary / 'sleep').chmod(0o755)
                # Preserve timeout's invocation contract without wasting wall time in fixtures.
                (binary / 'timeout').write_text('#!/bin/sh\nshift\nexec "$@"\n'); (binary / 'timeout').chmod(0o755)
                log = root / 'commands.txt'; out = root / 'diagnostics'
                env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ['PATH'], SCENARIO=scenario,
                           ADB_LOG=str(log), DIAGNOSTICS_DIR=str(out))
                result = subprocess.run([bash, str(SCRIPT), 'test-apks'], cwd=root, env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
                self.assertEqual((out / 'diagnostic-exit-code.txt').read_text().strip(), str(expected))
                for filename in ('logcat-all.txt', 'logcat-crash.txt', 'activity-exit-info.txt',
                                 'connectivity-after-test.txt', 'webview-version.txt', 'capture-status.txt'):
                    self.assertTrue((out / filename).is_file(), filename)
                commands = log.read_text()
                self.assertEqual('shell am instrument ' in commands, scenario != 'online')
                self.assertLessEqual(commands.count('shell am instrument '), 1)
                self.assertNotIn('shell svc data disable', commands)
                if scenario != 'online':
                    self.assertTrue((out / 'instrumentation-result.txt').is_file())
                    self.assertTrue((out / 'instrumentation-command-exit-code.txt').is_file())
                if scenario == 'transport_failure':
                    self.assertIn('adb transport failed', (out / 'instrumentation-result.txt').read_text())


if __name__ == '__main__': unittest.main()
