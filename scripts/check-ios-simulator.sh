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
NOSTALGIFY_APP_LOG_ID=''
NOSTALGIFY_ACTIVE_COMMAND_ID=''
# Leave time inside the 45-minute job for finalization and artifact upload.
NOSTALGIFY_COMMAND_DEADLINE=$((SECONDS + 1800))
NOSTALGIFY_PROJECT="$PWD/apps/ipad/ios/App/App.xcodeproj"
NOSTALGIFY_DERIVED_DATA="$NOSTALGIFY_IOS_RESULTS/DerivedData"
NOSTALGIFY_PACKAGE_LOCK="$NOSTALGIFY_PROJECT/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
NOSTALGIFY_STRICT_CONCURRENCY=${NOSTALGIFY_STRICT_CONCURRENCY:-complete}
case "$NOSTALGIFY_STRICT_CONCURRENCY" in
  minimal|targeted|complete) ;;
  *) echo 'Invalid NOSTALGIFY_STRICT_CONCURRENCY setting.' >&2; exit 1 ;;
esac
echo "iOS validation results: $NOSTALGIFY_IOS_RESULTS"

# shellcheck source=scripts/ios-ci-harness.sh
source scripts/ios-ci-harness.sh

cleanup() {
  local NOSTALGIFY_VALIDATION_STATUS=$?
  # Diagnostic collection must neither hide the original failure nor replace a
  # successful suite with an export error. Every collector below is best effort.
  set +e
  trap 'cancel_validation "$NOSTALGIFY_VALIDATION_STATUS" INT' INT
  trap 'cancel_validation "$NOSTALGIFY_VALIDATION_STATUS" TERM' TERM
  begin_collection_budget
  # Preserve a useful verdict before optional exports or a hard runner stop.
  GITHUB_STEP_SUMMARY='' bounded_command initial-summary 5 python3 scripts/ios-ci-diagnostics.py summarize \
    --output "$NOSTALGIFY_IOS_RESULTS" --exit-code "$NOSTALGIFY_VALIDATION_STATUS" || true
  # Stop only our wrapped diagnostic commands, not App or its WebContent process.
  stop_diagnostic_commands
  # Preserve a deduplicated inventory even when a build or UI test fails. Swift
  # 5 remains the language mode while first-party concurrency boundaries migrate.
  bounded_command warning-inventory 10 python3 - "$NOSTALGIFY_IOS_RESULTS" <<'PY'
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
    bounded_command result-summary 20 xcrun xcresulttool get test-results summary \
      --path "$NOSTALGIFY_IOS_RESULTS/tests.xcresult" \
      > "$NOSTALGIFY_IOS_RESULTS/test-summary.json" 2> "$NOSTALGIFY_IOS_RESULTS/result-summary.log" || true
    bounded_command result-tree 20 xcrun xcresulttool get test-results tests \
      --path "$NOSTALGIFY_IOS_RESULTS/tests.xcresult" \
      > "$NOSTALGIFY_IOS_RESULTS/test-tree.json" 2> "$NOSTALGIFY_IOS_RESULTS/result-tree.log" || true
    bounded_command attachment-export 30 xcrun xcresulttool export attachments --path "$NOSTALGIFY_IOS_RESULTS/tests.xcresult" \
      --output-path "$NOSTALGIFY_IOS_RESULTS/test-attachments" \
      > "$NOSTALGIFY_IOS_RESULTS/attachment-export.log" 2>&1 || true
  fi
  if [ -n "$NOSTALGIFY_SIMULATOR_ID" ]; then
    # UI tests attach their own app screenshot and hierarchy to tests.xcresult.
    # Preserve the failure screen separately from the earlier preflight launch.
    if [ "$NOSTALGIFY_VALIDATION_STATUS" -ne 0 ] || [ ! -f "$NOSTALGIFY_IOS_RESULTS/launch.png" ]; then
      bounded_command failure-screenshot 10 xcrun simctl io "$NOSTALGIFY_SIMULATOR_ID" screenshot "$NOSTALGIFY_IOS_RESULTS/failure-screen.png" \
        >/dev/null 2>&1 || true
    fi
    if [ "$NOSTALGIFY_VALIDATION_STATUS" -ne 0 ] && [ "$NOSTALGIFY_UI_TESTS_STARTED" = true ]; then
      # Compare a fresh fixture launch outside XCTest after its verdict is final.
      # This is diagnostic evidence only: no test is retried and the failed exit
      # status is preserved. Never run the comparison for a successful suite.
      NOSTALGIFY_COMPARISON_ID=$(uuidgen)
      if bounded_command comparison-launch 20 xcrun simctl launch --terminate-running-process "$NOSTALGIFY_SIMULATOR_ID" \
          dev.nostalgify.ipad --ui-testing "$NOSTALGIFY_COMPARISON_ID" \
          -AppleLanguages '(en)' -AppleLocale en_US \
          > "$NOSTALGIFY_IOS_RESULTS/comparison-launch.log" 2>&1; then
        NOSTALGIFY_CAPTURE_APP_DATA=''
        if bounded_command comparison-container 15 xcrun simctl get_app_container "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad data \
            > "$NOSTALGIFY_IOS_RESULTS/comparison-container.txt" 2>/dev/null; then
          NOSTALGIFY_CAPTURE_APP_DATA=$(cat "$NOSTALGIFY_IOS_RESULTS/comparison-container.txt")
        fi
        if [ -n "$NOSTALGIFY_CAPTURE_APP_DATA" ]; then
          bounded_command comparison-probe 30 python3 - "$NOSTALGIFY_CAPTURE_APP_DATA/Documents/UITestStartupDiagnostics" \
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
        bounded_command comparison-screenshot 10 xcrun simctl io "$NOSTALGIFY_SIMULATOR_ID" screenshot "$NOSTALGIFY_IOS_RESULTS/comparison.png" \
          > "$NOSTALGIFY_IOS_RESULTS/comparison-screenshot.log" 2>&1 || true
      fi
    fi
    # Probe filenames include fixture and launch UUIDs, so comparison/cold-launch
    # evidence cannot overwrite previous attempts or relaunch persistence tests.
    NOSTALGIFY_CAPTURE_APP_DATA=''
    if bounded_command evidence-container 15 xcrun simctl get_app_container "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad data \
        > "$NOSTALGIFY_IOS_RESULTS/evidence-container.txt" 2>/dev/null; then
      NOSTALGIFY_CAPTURE_APP_DATA=$(cat "$NOSTALGIFY_IOS_RESULTS/evidence-container.txt")
    fi
    if [ -n "$NOSTALGIFY_CAPTURE_APP_DATA" ]; then
      cp "$NOSTALGIFY_CAPTURE_APP_DATA/Documents/"native-selfcheck*.json "$NOSTALGIFY_IOS_RESULTS/" 2>/dev/null || true
    fi
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
    # App info-level messages are retained separately in the live stream. Keep
    # the broad system export at its normal level to avoid swamping that evidence.
    bounded_command simulator-log 30 xcrun simctl spawn "$NOSTALGIFY_SIMULATOR_ID" log show "${NOSTALGIFY_LOG_TIME_ARGUMENTS[@]}" --style compact \
      --predicate 'process == "App" OR process == "Nostalgify" OR process == "AppUITests-Runner" OR process == "testmanagerd" OR process == "runningboardd" OR process == "SpringBoard" OR subsystem BEGINSWITH "com.apple.WebKit" OR process == "VoiceOverTouch" OR process == "AccessibilityUIServer" OR process == "axassetsd" OR (subsystem == "com.apple.Accessibility" AND category == "AXVOAutomation")' \
      > "$NOSTALGIFY_IOS_RESULTS/simulator.log" 2>&1 || true
    begin_resource_cleanup_budget
    bounded_command simulator-shutdown 25 xcrun simctl shutdown "$NOSTALGIFY_SIMULATOR_ID" >/dev/null 2>&1 || true
    bounded_command simulator-delete 25 xcrun simctl delete "$NOSTALGIFY_SIMULATOR_ID" >/dev/null 2>&1 || true
  fi
  begin_resource_cleanup_budget
  bounded_command final-summary 5 python3 scripts/ios-ci-diagnostics.py summarize --output "$NOSTALGIFY_IOS_RESULTS" \
    --exit-code "$NOSTALGIFY_VALIDATION_STATUS" || true
  return "$NOSTALGIFY_VALIDATION_STATUS"
}
trap cleanup EXIT
trap 'cancel_validation 130 INT' INT
trap 'cancel_validation 143 TERM' TERM

bounded_command manifest 35 python3 scripts/ios-ci-diagnostics.py manifest --output "$NOSTALGIFY_IOS_RESULTS" || true

# These inventories are evidence only; capability and exact-runtime checks below
# remain required even if collecting the version text fails.
best_effort_logged_command xcode-version 10 "$NOSTALGIFY_IOS_RESULTS/xcode.log" xcodebuild -version
best_effort_command sdk-inventory 10 xcodebuild -showsdks > "$NOSTALGIFY_IOS_RESULTS/sdks.log"
# Check the selected toolchain's interface before opting out of its expensive
# system-wide post-failure collection. Test results and our own captures remain.
bounded_command xcode-help 20 python3 - "$NOSTALGIFY_IOS_RESULTS/xcodebuild-help.log" <<'PY'
import pathlib, subprocess, sys
result = subprocess.run(['xcodebuild', '-help'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
pathlib.Path(sys.argv[1]).write_text(result.stdout)
if '-collect-test-diagnostics' not in result.stdout:
    raise SystemExit('Selected Xcode does not support explicit test diagnostic collection policy.')
PY
node scripts/check-ios-project.cjs

# Both pinned dependencies are public. Avoid interactive Keychain access on a
# developer Mac when SwiftPM downloads their binary artifacts.
bounded_logged_command packages 300 "$NOSTALGIFY_IOS_RESULTS/packages.log" xcodebuild -resolvePackageDependencies -project "$NOSTALGIFY_PROJECT" -scheme App \
  -packageAuthorizationProvider netrc \
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages"
node scripts/check-ios-project.cjs
cp "$NOSTALGIFY_PACKAGE_LOCK" "$NOSTALGIFY_IOS_RESULTS/Package.resolved"

bounded_logged_command build-debug 600 "$NOSTALGIFY_IOS_RESULTS/build.log" xcodebuild build -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Debug \
  -packageAuthorizationProvider netrc \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$NOSTALGIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution \
  -resultBundlePath "$NOSTALGIFY_IOS_RESULTS/build.xcresult" \
  CODE_SIGNING_ALLOWED=NO "SWIFT_STRICT_CONCURRENCY=$NOSTALGIFY_STRICT_CONCURRENCY"

# Also compile the device SDK and Release-only paths, including the Spotify
# XCFramework's device slice. This is an unsigned build, never an archive/upload.
bounded_logged_command build-release 600 "$NOSTALGIFY_IOS_RESULTS/release.log" xcodebuild build -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Release \
  -packageAuthorizationProvider netrc \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$NOSTALGIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution \
  -resultBundlePath "$NOSTALGIFY_IOS_RESULTS/release.xcresult" \
  CODE_SIGNING_ALLOWED=NO "SWIFT_STRICT_CONCURRENCY=$NOSTALGIFY_STRICT_CONCURRENCY"

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
if [ -z "${NOSTALGIFY_IOS_RUNTIME:-}" ]; then
  bounded_command simulator-sdk 10 xcrun --sdk iphonesimulator --show-sdk-version \
    > "$NOSTALGIFY_IOS_RESULTS/simulator-sdk.txt"
  NOSTALGIFY_IOS_RUNTIME=$(cat "$NOSTALGIFY_IOS_RESULTS/simulator-sdk.txt")
fi
bounded_command simulator-inventory 15 xcrun simctl list --json > "$NOSTALGIFY_IOS_RESULTS/simulators.json"
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
bounded_command simulator-create 60 xcrun simctl create "Nostalgify validation $$" "$NOSTALGIFY_DEVICE_TYPE" "$NOSTALGIFY_RUNTIME" \
  > "$NOSTALGIFY_IOS_RESULTS/simulator-id.txt"
NOSTALGIFY_SIMULATOR_ID=$(cat "$NOSTALGIFY_IOS_RESULTS/simulator-id.txt")
python3 - "$NOSTALGIFY_IOS_RESULTS" "$NOSTALGIFY_SIMULATOR_ID" "$NOSTALGIFY_DEVICE_TYPE" "$NOSTALGIFY_RUNTIME" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
environment = json.loads((root / 'environment.json').read_text())
simulators = json.loads((root / 'simulators.json').read_text())
runtime = next(r for r in simulators['runtimes'] if r['identifier'] == sys.argv[4])
environment.update(simulatorUDID=sys.argv[2], deviceType=sys.argv[3], runtimeVersion=runtime['version'], runtimeBuild=runtime.get('buildversion'))
(root / 'environment.json').write_text(json.dumps(environment, indent=2) + '\n')
PY
bounded_command boot 60 xcrun simctl boot "$NOSTALGIFY_SIMULATOR_ID"
# Hosted-runner evidence includes successful 279s boots and 359s installs.
# These setup caps include margin; assertion and test-case allowances are unchanged.
bounded_logged_command boot-status 420 "$NOSTALGIFY_IOS_RESULTS/boot.log" \
  xcrun simctl bootstatus "$NOSTALGIFY_SIMULATOR_ID" -b

# Validate the first application launch outside XCTest before querying its
# accessibility tree. This remains a required, bounded startup/bridge gate; the
# subsequent UI cases start fresh app processes on a preflight-validated simulator.
NOSTALGIFY_VALIDATION_LOG_START=$(date '+%Y-%m-%d %H:%M:%S')
date '+%Y-%m-%d %H:%M:%S %z' > "$NOSTALGIFY_IOS_RESULTS/validation-started-at.log"
# Info events otherwise may be evicted before a late log-show export. Start the
# targeted stream before the first app launch and retain raw output incrementally.
python3 scripts/ios-ci-diagnostics.py run --output "$NOSTALGIFY_IOS_RESULTS" \
  --phase app-log-stream --timeout 1800 -- xcrun simctl spawn "$NOSTALGIFY_SIMULATOR_ID" \
  log stream --level info --style compact --predicate 'subsystem == "dev.nostalgify.ipad"' \
  > "$NOSTALGIFY_IOS_RESULTS/app-events.log" 2>&1 &
NOSTALGIFY_APP_LOG_ID=$!

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
bounded_command install 480 xcrun simctl install "$NOSTALGIFY_SIMULATOR_ID" "$NOSTALGIFY_BUILT_APP"
bounded_logged_command preflight-launch 120 "$NOSTALGIFY_IOS_RESULTS/launch.log" xcrun simctl launch --terminate-running-process "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad --native-local-selfcheck
bounded_command preflight-container-lookup 90 xcrun simctl get_app_container "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad data \
  > "$NOSTALGIFY_IOS_RESULTS/preflight-container.txt"
NOSTALGIFY_APP_DATA=$(cat "$NOSTALGIFY_IOS_RESULTS/preflight-container.txt")
for ((NOSTALGIFY_ATTEMPT = 0; NOSTALGIFY_ATTEMPT < 60; NOSTALGIFY_ATTEMPT++)); do
  if [ -f "$NOSTALGIFY_APP_DATA/Documents/native-selfcheck.json" ]; then break; fi
  sleep 1
done
cp "$NOSTALGIFY_APP_DATA/Documents/native-selfcheck.json" "$NOSTALGIFY_IOS_RESULTS/native-selfcheck.json"
cp "$NOSTALGIFY_APP_DATA/Documents/native-selfcheck-progress.json" "$NOSTALGIFY_IOS_RESULTS/" 2>/dev/null || true
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
# Capture only after validating the self-check so collection cannot extend its
# result wait. Cleanup captures failures separately. Successful hosted captures
# have exceeded ten seconds; allow thirty without making evidence a test gate.
best_effort_command preflight-screenshot 30 xcrun simctl io "$NOSTALGIFY_SIMULATOR_ID" screenshot "$NOSTALGIFY_IOS_RESULTS/launch.png"
# Do not leave the self-check process alive for the unit/UI test launches.
bounded_command preflight-terminate 30 xcrun simctl terminate "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad
python3 scripts/ios-ci-diagnostics.py run --output "$NOSTALGIFY_IOS_RESULTS" \
  --phase startup-watcher --timeout 1800 -- \
  python3 scripts/capture-ios-startup-stall.py "$NOSTALGIFY_SIMULATOR_ID" \
  "$NOSTALGIFY_APP_DATA/Documents/UITestStartupDiagnostics" "$NOSTALGIFY_IOS_RESULTS" \
  > "$NOSTALGIFY_IOS_RESULTS/startup-watcher.log" 2>&1 &
NOSTALGIFY_STARTUP_WATCHER_ID=$!
NOSTALGIFY_UI_TESTS_STARTED=true
date '+%Y-%m-%d %H:%M:%S %z' > "$NOSTALGIFY_IOS_RESULTS/test-started-at.log"
bounded_logged_command tests 1200 "$NOSTALGIFY_IOS_RESULTS/tests.log" xcodebuild test -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Debug \
  -packageAuthorizationProvider netrc \
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
  CODE_SIGNING_ALLOWED=NO "SWIFT_STRICT_CONCURRENCY=$NOSTALGIFY_STRICT_CONCURRENCY"

echo 'iOS builds, native and UI tests, local playback self-check, and launch passed. Physical Spotify/audio tests remain required.'
