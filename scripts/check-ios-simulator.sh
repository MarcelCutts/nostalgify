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
NOSTALGIFY_PROJECT="$PWD/apps/ipad/ios/App/App.xcodeproj"
NOSTALGIFY_DERIVED_DATA="$NOSTALGIFY_IOS_RESULTS/DerivedData"
echo "iOS validation results: $NOSTALGIFY_IOS_RESULTS"

cleanup() {
  if [ -n "$NOSTALGIFY_SIMULATOR_ID" ]; then
    xcrun simctl spawn "$NOSTALGIFY_SIMULATOR_ID" log show --last 5m --style compact \
      --predicate 'process == "App" OR process == "Nostalgify"' \
      > "$NOSTALGIFY_IOS_RESULTS/simulator.log" 2>&1 || true
    xcrun simctl shutdown "$NOSTALGIFY_SIMULATOR_ID" >/dev/null 2>&1 || true
    xcrun simctl delete "$NOSTALGIFY_SIMULATOR_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

xcodebuild -version | tee "$NOSTALGIFY_IOS_RESULTS/xcode.log"
xcodebuild -showsdks > "$NOSTALGIFY_IOS_RESULTS/sdks.log"
node scripts/check-ios-project.cjs

xcodebuild -resolvePackageDependencies -project "$NOSTALGIFY_PROJECT" -scheme App \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/packages.log"

xcodebuild build -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$NOSTALGIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  -resultBundlePath "$NOSTALGIFY_IOS_RESULTS/build.xcresult" \
  CODE_SIGNING_ALLOWED=NO \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/build.log"

# Also compile the device SDK and Release-only paths, including the Spotify
# XCFramework's device slice. This is an unsigned build, never an archive/upload.
xcodebuild build -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$NOSTALGIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  -resultBundlePath "$NOSTALGIFY_IOS_RESULTS/release.xcresult" \
  CODE_SIGNING_ALLOWED=NO \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/release.log"

# Create and remove our own simulator, leaving a developer's existing devices
# untouched. Choose an installed iOS runtime and a supported iPad device type.
xcrun simctl list --json > "$NOSTALGIFY_IOS_RESULTS/simulators.json"
read -r NOSTALGIFY_DEVICE_TYPE NOSTALGIFY_RUNTIME < <(python3 - "$NOSTALGIFY_IOS_RESULTS/simulators.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
runtimes = sorted((r for r in data['runtimes'] if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')), key=lambda r: tuple(map(int, r['version'].split('.'))), reverse=True)
for runtime in runtimes:
    for device in data['devices'].get(runtime['identifier'], []):
        if device.get('isAvailable') and device['name'].startswith('iPad') and device.get('deviceTypeIdentifier'):
            print(device['deviceTypeIdentifier'], runtime['identifier'])
            sys.exit(0)
raise SystemExit('No installed iPad simulator is available. Install an iOS runtime in Xcode.')
PY
)
NOSTALGIFY_SIMULATOR_ID=$(xcrun simctl create "Nostalgify validation $$" "$NOSTALGIFY_DEVICE_TYPE" "$NOSTALGIFY_RUNTIME")
xcrun simctl boot "$NOSTALGIFY_SIMULATOR_ID"
xcrun simctl bootstatus "$NOSTALGIFY_SIMULATOR_ID" -b \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/boot.log"

xcodebuild test -project "$NOSTALGIFY_PROJECT" -scheme App -configuration Debug \
  -destination "platform=iOS Simulator,id=$NOSTALGIFY_SIMULATOR_ID" \
  -parallel-testing-enabled NO \
  -derivedDataPath "$NOSTALGIFY_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$NOSTALGIFY_IOS_RESULTS/SourcePackages" \
  -resultBundlePath "$NOSTALGIFY_IOS_RESULTS/tests.xcresult" \
  CODE_SIGNING_ALLOWED=NO \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/tests.log"

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
xcrun simctl install "$NOSTALGIFY_SIMULATOR_ID" "$NOSTALGIFY_BUILT_APP"
xcrun simctl launch --terminate-running-process "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad --native-local-selfcheck \
  2>&1 | tee "$NOSTALGIFY_IOS_RESULTS/launch.log"
NOSTALGIFY_APP_DATA=$(xcrun simctl get_app_container "$NOSTALGIFY_SIMULATOR_ID" dev.nostalgify.ipad data)
for NOSTALGIFY_ATTEMPT in $(seq 1 60); do
  if [ -f "$NOSTALGIFY_APP_DATA/Documents/native-selfcheck.json" ]; then break; fi
  sleep 1
done
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
xcrun simctl io "$NOSTALGIFY_SIMULATOR_ID" screenshot "$NOSTALGIFY_IOS_RESULTS/launch.png"
echo 'iOS build, native tests, local playback self-check, and launch passed. Physical Spotify/audio tests remain required.'
