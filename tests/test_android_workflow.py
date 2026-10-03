"""Offline emulator setup must tolerate an absent phone service, not an online device."""
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def smoke_script():
    workflow = (ROOT / '.github/workflows/android.yml').read_text(encoding='utf-8')
    start = workflow.index('          script: |\n') + len('          script: |\n')
    end = workflow.index('      - uses: actions/upload-artifact', start)
    return textwrap.dedent(workflow[start:end])


class AndroidWorkflowTest(unittest.TestCase):
    def test_offline_preconditions_and_diagnostics_are_present(self):
        script = smoke_script()
        self.assertIn('service check phone', script)
        self.assertIn("*': found'*) adb shell svc data disable", script)
        self.assertIn("*': not found'*)", script)
        self.assertIn('Unexpected phone service status', script)
        self.assertIn("test \"$(adb shell settings get global wifi_on | tr -d '\\r')\" = '0'", script)
        assertion = "grep -q 'Active default network: none' connectivity-before-test.txt"
        self.assertLess(script.rindex(assertion), script.index('adb shell am instrument'))
        self.assertNotIn('|| true', script)
        workflow = (ROOT / '.github/workflows/android.yml').read_text(encoding='utf-8')
        self.assertIn('emulator-boot-timeout: 900', workflow)
        for name in ('connectivity-before-test.txt', 'webview-version.txt', 'android-runtime-log.txt'):
            self.assertIn('            ' + name, workflow)

    @unittest.skipIf(os.name == 'nt', 'Shell execution is covered on the Linux emulator runner')
    def test_only_verified_offline_devices_reach_instrumentation(self):
        shell = shutil.which('sh')
        if not shell:
            self.skipTest('sh is unavailable')
        fake_adb = r'''#!/bin/sh
printf '%s\n' "$*" >> "$ADB_LOG"
case "$*" in
  'install '*) exit 0 ;;
  'shell svc wifi disable') [ "$SCENARIO" != wifi_disable_failure ] || exit 17 ;;
  'shell service check phone')
    case "$SCENARIO" in
      no_phone) printf 'Service phone: not found\r\n' ;;
      unexpected) printf 'unrecognized service manager response\r\n' ;;
      service_query_failure) exit 19 ;;
      *) printf 'Service phone: found\r\n' ;;
    esac ;;
  'shell svc data disable')
    case "$SCENARIO" in no_phone|data_disable_failure) exit 20 ;; esac ;;
  'shell settings get global wifi_on')
    if [ "$SCENARIO" = wifi_still_enabled ]; then echo 1; else echo 0; fi ;;
  'shell dumpsys connectivity')
    [ "$SCENARIO" != connectivity_query_failure ] || exit 18
    if [ "$SCENARIO" = network_still_active ]; then echo 'Active default network: 100'; else echo 'Active default network: none'; fi ;;
  'shell dumpsys webviewupdate') echo 'Current WebView package: fixture' ;;
  'shell am instrument '*) echo 'OK (1 test)' ;;
  'logcat -d -s AndroidRuntime chromium') echo 'runtime fixture' ;;
  *) echo "Unexpected adb command: $*" >&2; exit 99 ;;
esac
'''
        scenarios = {'no_phone': True, 'phone_found': True, 'unexpected': False,
                     'data_disable_failure': False, 'wifi_disable_failure': False,
                     'wifi_still_enabled': False, 'network_still_active': False,
                     'service_query_failure': False, 'connectivity_query_failure': False}
        for scenario, succeeds in scenarios.items():
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); binary = root / 'bin'; binary.mkdir()
                (binary / 'adb').write_text(fake_adb, encoding='utf-8'); (binary / 'adb').chmod(0o755)
                (binary / 'sleep').write_text('#!/bin/sh\nexit 0\n', encoding='utf-8'); (binary / 'sleep').chmod(0o755)
                log = root / 'adb.log'
                env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ['PATH'], SCENARIO=scenario, ADB_LOG=str(log))
                # android-emulator-runner executes each script line through a fresh
                # shell. Match that behavior; do not rely on persistent shell state
                # or stronger aggregate bash -e/pipefail settings.
                for command in smoke_script().splitlines():
                    if not command.strip():
                        continue
                    result = subprocess.run([shell, '-c', command], cwd=root, env=env, capture_output=True, text=True, timeout=10)
                    if result.returncode:
                        break
                commands = log.read_text(encoding='utf-8')
                self.assertEqual(result.returncode == 0, succeeds, result.stderr + result.stdout)
                self.assertEqual('shell am instrument ' in commands, succeeds)
                if scenario == 'no_phone':
                    self.assertNotIn('shell svc data disable', commands)
                if scenario == 'phone_found':
                    self.assertIn('shell svc data disable', commands)
                if succeeds:
                    self.assertIn('Active default network: none', (root / 'connectivity-before-test.txt').read_text())
                    self.assertTrue((root / 'webview-version.txt').is_file())
                    self.assertTrue((root / 'android-runtime-log.txt').is_file())


if __name__ == '__main__': unittest.main()
