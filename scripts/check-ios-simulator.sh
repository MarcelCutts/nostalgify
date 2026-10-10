#!/bin/bash
# Compile, run native tests, and launch the real application without signing or
# Spotify credentials. Run npm run build && npm run ipad:sync beforehand.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != Darwin ]; then
  echo 'The iOS simulator check requires macOS with Xcode 26 or newer.' >&2
  exit 1
fi

mkdir -p out/ios-ci
NOSTALGIFY_IOS_RESULTS=$(mktemp -d "$PWD/out/ios-ci/run.XXXXXX")
NOSTALGIFY_SIMULATOR_ID=''
NOSTALGIFY_VALIDATION_LOG_START=''
NOSTALGIFY_UI_TESTS_STARTED=false
NOSTALGIFY_STARTUP_WATCHER_ID=''
NOSTALGIFY_PROJECT="$PWD/apps/ipad/ios/App/App.xcodeproj"
NOSTALGIFY_DERIVED_DATA="$NOSTALGIFY_IOS_RESULTS/DerivedData"
NOSTALGIFY_PACKAGE_LOCK="$NOSTALGIFY_PROJECT/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
NOSTALGIFY_STRICT_CONCURRENCY=${NOSTALGIFY_STRICT_CONCURRENCY:-complete}
case "$NOSTALGIFY_STRICT_CONCURRENCY" in
  minimal|targeted|complete) ;;
  *) echo 'Invalid NOSTALGIFY_STRICT_CONCURRENCY setting.' >&2; exit 1 ;;
esac
echo "iOS validation results: $NOSTALGIFY_IOS_RESULTS"

timed_simulator_command() {
  local NOSTALGIFY_TIMING_LABEL=$1
  shift
  local NOSTALGIFY_TIMING_STARTED=$SECONDS
  local NOSTALGIFY_TIMING_STATUS
  # Keep timing evidence separate from command stdout, including when the caller
  # captures a container path. Record starts too, so an unfinished command is visible.
  printf '%s\t%s\tstarted\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$NOSTALGIFY_TIMING_LABEL" \
    >> "$NOSTALGIFY_IOS_RESULTS/simulator-command-timings.log" || true
  if "$@"; then
    NOSTALGIFY_TIMING_STATUS=0
  else
    NOSTALGIFY_TIMING_STATUS=$?
  fi
  printf '%s\t%s\tfinished\telapsedSeconds=%s\texitCode=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$NOSTALGIFY_TIMING_LABEL" \
    "$((SECONDS - NOSTALGIFY_TIMING_STARTED))" "$NOSTALGIFY_TIMING_STATUS" \
    >> "$NOSTALGIFY_IOS_RESULTS/simulator-command-timings.log" || true
  return "$NOSTALGIFY_TIMING_STATUS"
}

cleanup() {
  local NOSTALGIFY_VALIDATION_STATUS=$?
  # Diagnostic collection must neither hide the original failure nor replace a
  # successful suite with an export error. Every collector below is best effort.
  set +e
  if [ -n "$NOSTALGIFY_STARTUP_WATCHER_ID" ]; then
    # Only stop our diagnostic watcher. Its subprocesses have bounded timeouts;
    # neither the application nor its WebContent process is terminated here.
    for NOSTALGIFY_CHILD_PID in $(jobs -pr); do
      if [ "$NOSTALGIFY_CHILD_PID" = "$NOSTALGIFY_STARTUP_WATCHER_ID" ]; then
        kill "$NOSTALGIFY_STARTUP_WATCHER_ID" 2>/dev/null || true
      fi
    done
    wait "$NOSTALGIFY_STARTUP_WATCHER_ID" 2>/dev/null || true
  fi
  # Preserve a deduplicated inventory even when a build or UI test fails. Swift
  # 5 remains the language mode while first-party concurrency boundaries migrate.
  python3 - "$NOSTALGIFY_IOS_RESULTS" <<'PY'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
diagnostics = {}
for log in root.glob('*.log'):
    for line in log.read_text(errors='replace').splitlines():
        match = re.search(r'(apps/ipad/ios/[^:\n]+\.swift):\d+:\d+: warning: (.+)', line)
        if match:
            source, message = match.groups()
            diagnostics[(source, message)] = {'source': source, 'message': message}
(root / 'swift-warnings.json').write_text(json.dumps(list(diagnostics.values()), indent=2) + '\n')
print(f'Captured {len(diagnostics)} distinct first-party Swift warning diagnostics.')
PY
  if [ -d "$NOSTALGIFY_IOS_RESULTS/tests.xcresult" ]; then
    # Export screenshots and accessibility hierarchies for inspection without
    # Xcode. The original result bundle remains authoritative if export fails.
    xcrun xcresulttool export attachments --path "$NOSTALGIFY_IOS_RESULTS/tests.xcresult" \
      --output-path "$NOSTALGIFY_IOS_RESULTS/test-attachments" \
      > "$NOSTALGIFY_IOS_RESULTS/attachment-export.log" 2>&1 || true
  fi
  if [ -n "$NOSTALGIFY_SIMULATOR_ID" ]; then
    # UI tests attach their own app screenshot and hierarchy to tests.xcresult.
    # Preserve the failure screen separately from the earlier preflight launch.
    if [ "$NOSTALGIFY_VALIDATION_STATUS" -ne 0 ] || [ ! -f "$NOSTALGIFY_IOS_RESULTS/launch.png" ]; then
      xcrun simctl io "$NOSTALGIFY_SIMULATOR_ID" screenshot "$NOSTALGIFY_IOS_RESULTS/failure-screen.png" \
        >/dev/null 2>&1 || true
    fi
    if [ "$NOSTALGIFY_VALIDATION_STATUS" -ne 0 ] && [ "$NOSTALGIFY_UI_TESTS_STARTED" = true ]; then
      # Compare a fresh fixture launch outside XCTest after its verdict is final.
      # This is diagnostic evidence only: no test is retried and the failed exit
      # status is preserved. Never run the comparison for a successful suite.
      NOSTALGIFY_COMPARISON_ID=$(uuidgen)
      if xcrun simctl launch --terminate-running-process "$NOSTALGIFY_SIMULATOR_ID" \
          dev.nostalgify.ipad --ui-testing "$NOSTALGIFY_COMPARISON_ID" \
          -AppleLanguages '(en)' -AppleLocale en_US \
          > "$NOSTALGIFY_IOS_RESULTS/comparison-launch.log" 2>&1; then
        NOSTALGIFY_CAPTURE_APP_DATA=$(xcrun simctl get_app_container "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad data 2>/dev/null)
        if [ -n "$NOSTALGIFY_CAPTURE_APP_DATA" ]; then
          python3 - "$NOSTALGIFY_CAPTURE_APP_DATA/Documents/UITestStartupDiagnostics" \
          "$NOSTALGIFY_COMPARISON_ID" "$NOSTALGIFY_IOS_RESULTS/comparison.json" <<'PY'
import json, pathlib, sys, time
directory, identifier, output = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
started, completed = time.monotonic(), False
while time.monotonic() - started < 25:
    for file in directory.glob(identifier + '-*.json'):
        try:
            if json.loads(file.read_text()).get('phase') == 'completed':
                completed = True
        except (OSError, ValueError):
            pass
    if completed:
        break
    time.sleep(1)
output.write_text(json.dumps({'diagnosticOnly': True, 'fixtureID': identifier, 'probeCompleted': completed, 'waitedSeconds': round(time.monotonic() - started, 1), 'waitLimitSeconds': 25}, indent=2) + '\n')
PY
        fi
        xcrun simctl io "$NOSTALGIFY_SIMULATOR_ID" screenshot "$NOSTALGIFY_IOS_RESULTS/comparison.png" \
          > "$NOSTALGIFY_IOS_RESULTS/comparison-screenshot.log" 2>&1 || true
      fi
    fi
    # Probe filenames include fixture and launch UUIDs, so comparison/cold-launch
    # evidence cannot overwrite previous attempts or relaunch persistence tests.
    NOSTALGIFY_CAPTURE_APP_DATA=$(xcrun simctl get_app_container "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad data 2>/dev/null)
    if [ -n "$NOSTALGIFY_CAPTURE_APP_DATA" ] && [ -d "$NOSTALGIFY_CAPTURE_APP_DATA/Documents/UITestStartupDiagnostics" ]; then
      mkdir -p "$NOSTALGIFY_IOS_RESULTS/startup-probes"
      cp "$NOSTALGIFY_CAPTURE_APP_DATA/Documents/UITestStartupDiagnostics/"*.json \
        "$NOSTALGIFY_IOS_RESULTS/startup-probes/" 2>/dev/null || true
    fi
    # The first cold launch may fail well before the last five minutes. Retain
    # the preflight and test interval, bounded by the 45-minute job deadline.
    NOSTALGIFY_LOG_TIME_ARGUMENTS=(--last 45m)
    if [ -n "$NOSTALGIFY_VALIDATION_LOG_START" ]; then
      NOSTALGIFY_LOG_TIME_ARGUMENTS=(--start "$NOSTALGIFY_VALIDATION_LOG_START")
    fi
    # Include the VoiceOver and accessibility services identified in actual
    # simulator launch records, plus the exact automation category across clients.
    xcrun simctl spawn "$NOSTALGIFY_SIMULATOR_ID" log show "${NOSTALGIFY_LOG_TIME_ARGUMENTS[@]}" --style compact \
      --predicate 'process == "App" OR process == "Nostalgify" OR process == "AppUITests-Runner" OR process == "testmanagerd" OR process == "runningboardd" OR process == "SpringBoard" OR subsystem BEGINSWITH "com.apple.WebKit" OR process == "VoiceOverTouch" OR process == "AccessibilityUIServer" OR process == "axassetsd" OR (subsystem == "com.apple.Accessibility" AND category == "AXVOAutomation")' \
      > "$NOSTALGIFY_IOS_RESULTS/simulator.log" 2>&1 || true
    xcrun simctl shutdown "$NOSTALGIFY_SIMULATOR_ID" >/dev/null 2>&1 || true
    xcrun simctl delete "$NOSTALGIFY_SIMULATOR_ID" >/dev/null 2>&1 || true
  fi
  return "$NOSTALGIFY_VALIDATION_STATUS"
}
trap cleanup EXIT

xcodebuild -version | tee "$NOSTALGIFY_IOS_RESULTS/xcode.log"
xcodebuild -showsdks > "$NOSTALGIFY_IOS_RESULTS/sdks.log"
# Check the selected toolchain's interface before opting out of its expensive
# system-wide post-failure collection. Test results and our own captures remain.
python3 - "$NOSTALGIFY_IOS_RESULTS/xcodebuild-help.log" <<'PY'
import pathlib, subprocess, sys
result = subprocess.run(['xcodebuild', '-help'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
pathlib.Path(sys.argv[1]).write_text(result.stdout)
if '-collect-test-diagnostics' not in result.stdout:
    raise SystemExit('Selected Xcode does not support explicit test diagnostic collection policy.')
PY
node scripts/check-ios-project.cjs

xcodebuild -resolvePackageDependencies -project "$NOSTALGIFY_PROJECT" -scheme App \
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/packages.log"
node scripts/check-ios-project.cjs
cp "$NOSTALGIFY_PACKAGE_LOCK" "$NOSTALGIFY_IOS_RESULTS/Package.resolved"

xcodebuild build -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$NOSTALGIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution \
  -resultBundlePath "$NOSTALGIFY_IOS_RESULTS/build.xcresult" \
  CODE_SIGNING_ALLOWED=NO "SWIFT_STRICT_CONCURRENCY=$NOSTALGIFY_STRICT_CONCURRENCY" \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/build.log"

# Also compile the device SDK and Release-only paths, including the Spotify
# XCFramework's device slice. This is an unsigned build, never an archive/upload.
xcodebuild build -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$NOSTALGIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution \
  -resultBundlePath "$NOSTALGIFY_IOS_RESULTS/release.xcresult" \
  CODE_SIGNING_ALLOWED=NO "SWIFT_STRICT_CONCURRENCY=$NOSTALGIFY_STRICT_CONCURRENCY" \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/release.log"

# Check the compiled executable, not just the source-level #if DEBUG directive.
# A positive Debug marker guards against a vacuous exclusion check.
python3 - "$NOSTALGIFY_DERIVED_DATA/Build/Products" "$NOSTALGIFY_IOS_RESULTS/release-fixture-check.json" <<'PY'
import json, pathlib, plistlib, sys
products = pathlib.Path(sys.argv[1])
def executable_images(configuration):
    for app in (products / configuration).glob('*.app'):
        with (app / 'Info.plist').open('rb') as file:
            info = plistlib.load(file)
        if info.get('CFBundleIdentifier') == 'dev.nostalgify.ipad':
            # Xcode's Debug executable can be only a trampoline: the application
            # code then lives in App.debug.dylib. Include first-party dylibs for
            # both configurations so neither layout can bypass this check.
            paths = [app / info['CFBundleExecutable'], *sorted(app.glob('*.dylib'))]
            return {path.name: path.read_bytes() for path in paths}
    raise SystemExit(f'Built app executable missing for {configuration}.')
debug = executable_images('Debug-iphonesimulator')
release = executable_images('Release-iphoneos')
markers = [b'--ui-testing', b'dev.nostalgify.ipad.uitests.', b'UI test fixture failed', b'UITestStartupDiagnostics']
debug_fixture = any(markers[1] in image for image in debug.values())
release_markers = [marker.decode() for marker in markers if any(marker in image for image in release.values())]
result = {'passed': debug_fixture and not release_markers, 'debugFixturePresent': debug_fixture, 'releaseFixtureMarkers': release_markers, 'debugImages': list(debug), 'releaseImages': list(release)}
pathlib.Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
if not result['passed']:
    raise SystemExit('Release fixture exclusion failed; inspect release-fixture-check.json.')
print('Compiled Debug fixture confirmed; Release executable excludes UI test markers.')
PY

# Create and remove our own simulator, leaving a developer's existing devices
# untouched. CI selects an exact runtime; local use defaults to the selected
# Xcode's SDK version. Never silently run a newer installed beta runtime.
NOSTALGIFY_IOS_RUNTIME=${NOSTALGIFY_IOS_RUNTIME:-$(xcrun --sdk iphonesimulator --show-sdk-version)}
xcrun simctl list --json > "$NOSTALGIFY_IOS_RESULTS/simulators.json"
read -r NOSTALGIFY_DEVICE_TYPE NOSTALGIFY_RUNTIME < <(python3 - "$NOSTALGIFY_IOS_RESULTS/simulators.json" "$NOSTALGIFY_IOS_RUNTIME" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
def version(value):
    parts = [int(p) for p in value.split('.')]
    return tuple((parts + [0, 0, 0])[:3])
runtimes = [r for r in data['runtimes'] if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-') and version(r['version']) == version(sys.argv[2])]
for runtime in runtimes:
    for device in data['devices'].get(runtime['identifier'], []):
        if device.get('isAvailable') and device['name'].startswith('iPad') and device.get('deviceTypeIdentifier'):
            print(device['deviceTypeIdentifier'], runtime['identifier'])
            sys.exit(0)
raise SystemExit(f'No installed iPad simulator for iOS {sys.argv[2]}. Install that exact runtime in Xcode.')
PY
)
python3 - "$NOSTALGIFY_IOS_RESULTS/environment.json" "$NOSTALGIFY_IOS_RUNTIME" "$NOSTALGIFY_RUNTIME" "$NOSTALGIFY_STRICT_CONCURRENCY" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as file:
    json.dump({'requestedRuntime': sys.argv[2], 'selectedRuntime': sys.argv[3], 'strictConcurrency': sys.argv[4]}, file, indent=2)
PY
NOSTALGIFY_SIMULATOR_ID=$(xcrun simctl create "Nostalgify validation $$" "$NOSTALGIFY_DEVICE_TYPE" "$NOSTALGIFY_RUNTIME")
timed_simulator_command boot xcrun simctl boot "$NOSTALGIFY_SIMULATOR_ID"
timed_simulator_command boot-status xcrun simctl bootstatus "$NOSTALGIFY_SIMULATOR_ID" -b \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/boot.log"

# Validate the first application launch outside XCTest before querying its
# accessibility tree. This remains a required, bounded startup/bridge gate; the
# subsequent UI cases start fresh app processes on a preflight-validated simulator.
NOSTALGIFY_VALIDATION_LOG_START=$(date '+%Y-%m-%d %H:%M:%S')
date '+%Y-%m-%d %H:%M:%S %z' > "$NOSTALGIFY_IOS_RESULTS/validation-started-at.log"

NOSTALGIFY_BUILT_APP=$(python3 - "$NOSTALGIFY_DERIVED_DATA/Build/Products/Debug-iphonesimulator" <<'PY'
import pathlib, plistlib, sys
for app in pathlib.Path(sys.argv[1]).glob('*.app'):
    with (app / 'Info.plist').open('rb') as file:
        if plistlib.load(file).get('CFBundleIdentifier') == 'dev.nostalgify.ipad':
            print(app)
            sys.exit(0)
raise SystemExit('Built Nostalgify iPad app was not found.')
PY
)
timed_simulator_command install xcrun simctl install "$NOSTALGIFY_SIMULATOR_ID" "$NOSTALGIFY_BUILT_APP"
timed_simulator_command preflight-launch xcrun simctl launch --terminate-running-process "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad --native-local-selfcheck \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/launch.log"
NOSTALGIFY_APP_DATA=$(timed_simulator_command preflight-container-lookup xcrun simctl get_app_container "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad data)
for NOSTALGIFY_ATTEMPT in $(seq 1 60); do
  if [ -f "$NOSTALGIFY_APP_DATA/Documents/native-selfcheck.json" ]; then break; fi
  sleep 1
done
# Capture the mounted UI even when the self-check fails or times out.
xcrun simctl io "$NOSTALGIFY_SIMULATOR_ID" screenshot "$NOSTALGIFY_IOS_RESULTS/launch.png"
cp "$NOSTALGIFY_APP_DATA/Documents/native-selfcheck.json" "$NOSTALGIFY_IOS_RESULTS/native-selfcheck.json"
python3 - "$NOSTALGIFY_IOS_RESULTS/native-selfcheck.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
required = {'import', 'distinct-identities', 'native-queue', 'persistence', 'webview-bridge'}
if result.get('passed') is not True or not required.issubset(result.get('checks', [])):
    raise SystemExit('Native local-file self-check failed; inspect native-selfcheck.json.')
if result.get('libraryCount') != 2 or result.get('provider') != 'local' or result.get('state') != 'stopped':
    raise SystemExit('Native self-check produced an unexpected final library/playback state.')
print('Native import, queue advancement, persistence, mounted UI, and Capacitor bridge self-check passed.')
PY
# Do not leave the self-check process alive for the unit/UI test launches.
xcrun simctl terminate "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad
python3 scripts/capture-ios-startup-stall.py "$NOSTALGIFY_SIMULATOR_ID" \
  "$NOSTALGIFY_APP_DATA/Documents/UITestStartupDiagnostics" "$NOSTALGIFY_IOS_RESULTS" \
  > "$NOSTALGIFY_IOS_RESULTS/startup-watcher.log" 2>&1 &
NOSTALGIFY_STARTUP_WATCHER_ID=$!
NOSTALGIFY_UI_TESTS_STARTED=true
date '+%Y-%m-%d %H:%M:%S %z' > "$NOSTALGIFY_IOS_RESULTS/test-started-at.log"
xcodebuild test -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Debug \
  -destination "platform=iOS Simulator,id=$NOSTALGIFY_SIMULATOR_ID" \
  -parallel-testing-enabled NO \
  -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 120 \
  -maximum-test-execution-time-allowance 180 \
  -collect-test-diagnostics never \
  -derivedDataPath "$NOSTALGIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution \
  -resultBundlePath "$NOSTALGIFY_IOS_RESULTS/tests.xcresult" \
  CODE_SIGNING_ALLOWED=NO "SWIFT_STRICT_CONCURRENCY=$NOSTALGIFY_STRICT_CONCURRENCY" \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/tests.log"

echo 'iOS builds, native and UI tests, local playback self-check, and launch passed. Physical Spotify/audio tests remain required.'
