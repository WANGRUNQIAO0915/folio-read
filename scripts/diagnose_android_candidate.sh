#!/usr/bin/env bash
# One attempt using already checksum-verified PR4 candidate APKs. No rebuild/sign.
set -euo pipefail
apks="${1:-test-apks}"
out="${DIAGNOSTICS_DIR:-pr4-diagnostics}"
mkdir -p "$out"

collect_diagnostics() {
  local result=$?
  trap - EXIT
  set +e
  # Run while the emulator is still alive, including when instrumentation fails.
  capture() {
    local name=$1
    shift
    timeout 30s "$@" > "$out/$name" 2>&1
    printf '%s: %s\n' "$name" "$?" >> "$out/capture-status.txt"
  }
  capture logcat-all.txt adb logcat -b all -d -v threadtime
  capture logcat-crash.txt adb logcat -b crash -d -v threadtime
  capture activity-exit-info.txt adb shell dumpsys activity exit-info io.github.wangrunqiao0915.folioread.debug
  capture connectivity-after-test.txt adb shell dumpsys connectivity
  capture webview-version.txt adb shell dumpsys webviewupdate
  printf '%s\n' "$result" > "$out/diagnostic-exit-code.txt"
  exit "$result"
}
trap collect_diagnostics EXIT

adb install "$apks/debug/app-debug.apk"
adb install "$apks/androidTest/debug/app-debug-androidTest.apk"
adb shell svc wifi disable
phone_status="$(adb shell service check phone | tr -d '\r')"
case "$phone_status" in
  *': found'*) adb shell svc data disable ;;
  *': not found'*) echo 'No phone service exists; no cellular data service to disable.' ;;
  *) echo "Unexpected phone service status: $phone_status"; exit 1 ;;
esac
for i in $(seq 1 30); do
  [ "$(adb shell settings get global wifi_on | tr -d '\r')" = '0' ] && break
  sleep 2
done
test "$(adb shell settings get global wifi_on | tr -d '\r')" = '0'
for i in $(seq 1 30); do
  adb shell dumpsys connectivity > "$out/connectivity-before-test.txt"
  grep -q 'Active default network: none' "$out/connectivity-before-test.txt" && break
  sleep 2
done
grep -q 'Active default network: none' "$out/connectivity-before-test.txt"

# am instrument can return 0 even after a process crash. Preserve its output and
# transport status separately, then also require the actual test-success marker.
set +e
timeout 600s adb shell am instrument -w io.github.wangrunqiao0915.folioread.debug.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | tee "$out/instrumentation-result.txt"
result=${PIPESTATUS[0]}
set -e
printf '%s\n' "$result" > "$out/instrumentation-command-exit-code.txt"
if [ "$result" -ne 0 ]; then exit "$result"; fi
if grep -q 'Process crashed' "$out/instrumentation-result.txt"; then exit 1; fi
grep -Eq '^OK \([0-9]+ tests?\)' "$out/instrumentation-result.txt"
