#!/usr/bin/env node
'use strict';

// Portable structural checks catch missing target membership and unsafe build
// configuration on Linux. These complement, never replace, the Xcode CI build.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const failures = [];
const fail = (message) => failures.push(message);
const read = (relative) => {
  try { return fs.readFileSync(path.join(root, relative), 'utf8'); }
  catch { fail(`Missing ${relative}`); return ''; }
};
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const base = 'apps/ipad/ios/App';
const project = read(`${base}/App.xcodeproj/project.pbxproj`);
const packageFile = read(`${base}/CapApp-SPM/Package.swift`);
const scheme = read(`${base}/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`);

if (!/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?dev\.nostalgify\.ipad"?\s*;/.test(project)) fail('Missing iPad application bundle identifier');
const families = [...project.matchAll(/TARGETED_DEVICE_FAMILY\s*=\s*"?([^";]+)"?\s*;/g)].map((match) => match[1].trim());
if (!families.length || families.some((family) => family !== '2')) fail('All native targets must target iPad (device family 2)');
const targets = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([\d.]+)\s*;/g)].map((match) => Number(match[1]));
if (!targets.length || targets.some((value) => !Number.isFinite(value) || value < 17)) fail('Native deployment targets must match the web runtime (iPadOS 17+)');
if (/layoutprobe|DEVELOPMENT_TEAM\s*=\s*"?[A-Z0-9]{10}"?\s*;/.test(project)) fail('Remove probe identifiers or a committed personal signing team');
if (!/capacitor-swift-pm\.git"\s*,\s*exact:\s*"8\.5\.3"/.test(packageFile)) fail('Capacitor Swift package must be pinned to 8.5.3');
if (!/spotify\/ios-sdk(?:\.git)?/.test(project + packageFile)
    || !/(?:kind\s*=\s*exactVersion;\s*version\s*=\s*5\.0\.1|exact:\s*"5\.0\.1")/.test(project + packageFile)) {
  fail('Spotify iOS SDK must use its official repository and an exact 5.0.1 version');
}
// These revisions were verified against the official annotated/lightweight tag
// targets, not guessed from version strings. Both manifests have no dependencies.
const expectedPins = {
  'capacitor-swift-pm': ['https://github.com/ionic-team/capacitor-swift-pm.git', '8.5.3', '4c7f346d16196e21fbe23d4a7a6fc7af62af6742'],
  'ios-sdk': ['https://github.com/spotify/ios-sdk.git', '5.0.1', '0b3e54771738ad5e64f22c8e5e19ca76d6becc6c'],
};
const resolvedText = read(`${base}/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`);
try {
  const resolved = JSON.parse(resolvedText);
  if (![2, 3].includes(resolved.version) || !Array.isArray(resolved.pins) || resolved.pins.length !== Object.keys(expectedPins).length) {
    fail('Package.resolved must contain precisely the reviewed remote dependency graph');
  }
  for (const [identity, [location, version, revision]] of Object.entries(expectedPins)) {
    const pin = resolved.pins?.find((value) => value.identity === identity);
    if (pin?.kind !== 'remoteSourceControl' || pin.location !== location || pin.state?.version !== version || pin.state?.revision !== revision) {
      fail(`Package.resolved has a missing or unreviewed ${identity} revision`);
    }
  }
} catch { fail('Package.resolved is not valid JSON'); }
for (const target of ['AppTests', 'AppUITests']) {
  const testables = [...scheme.matchAll(/<TestableReference\s+skipped\s*=\s*"NO"[^>]*>([\s\S]*?)<\/TestableReference>/g)];
  if (!testables.some((match) => match[1].includes(`BlueprintName="${target}"`))) {
    fail(`The shared App scheme must run ${target}, not merely build the application`);
  }
}

function verifySwiftSources(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) { fail(`Missing Swift source directory ${directory}`); return 0; }
  let count = 0;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) count += verifySwiftSources(relative);
    else if (entry.name.endsWith('.swift')) {
      count++;
      const memberships = [...project.matchAll(new RegExp(`/\\* ${escaped(entry.name)} in Sources \\*/`, 'g'))].length;
      if (memberships < 2) fail(`${relative} is missing Xcode source build-phase membership`);
    }
  }
  return count;
}
verifySwiftSources(`${base}/App`);
if (!verifySwiftSources('apps/ipad/ios/Tests')) fail('No native XCTest source files found');
if (!verifySwiftSources('apps/ipad/ios/UITests')) fail('No native XCUITest source files found');

const controller = read(`${base}/App/NostalgifyViewController.swift`);
if (!/registerPluginInstance\s*\(\s*NostalgifyNativePlugin\s*\(/.test(controller)) fail('Native Capacitor plugin is not explicitly registered');

const plistPath = path.join(root, base, 'App/Info.plist');
const plistResult = spawnSync('python3', ['-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', plistPath], { encoding: 'utf8' });
if (plistResult.status !== 0) {
  fail('Info.plist is not a valid property list (Python 3 is required for this portable check)');
} else {
  const plist = JSON.parse(plistResult.stdout);
  if (!plist.UIBackgroundModes?.includes('audio')) fail('Background audio mode is missing');
  if (!plist.LSApplicationQueriesSchemes?.includes('spotify')) fail('Spotify installation discovery URL scheme is missing');
  if (!plist.CFBundleURLTypes?.some((type) => type.CFBundleURLSchemes?.length)) fail('OAuth callback URL scheme is missing');
  if (plist.NSAppTransportSecurity?.NSAllowsArbitraryLoads) fail('Global insecure HTTP transport exemption is not allowed');
}

const nativeConfigPath = `${base}/App/capacitor.config.json`;
const nativeConfigText = read(nativeConfigPath);
if (nativeConfigText) {
  try {
    const config = JSON.parse(nativeConfigText);
    if (config.appId !== 'dev.nostalgify.ipad') fail('Synced Capacitor app ID differs from the Xcode target');
    if (config.server?.url) fail('Native application must load bundled assets, not a development server URL');
    if (config.server?.cleartext === true) fail('Capacitor cleartext development networking must not be enabled');
  } catch { fail(`${nativeConfigPath} is not JSON`); }
}
if (!fs.existsSync(path.join(root, base, 'App/public/index.html'))) fail('Bundled iPad UI is missing; run npm run ipad:sync');

if (failures.length) {
  console.error(`iOS project checks failed:\n${failures.map((value) => `- ${value}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('iOS structure passed: pinned packages, linked Swift sources/tests, plugin, callbacks, bundled UI, and audio mode.');
}
