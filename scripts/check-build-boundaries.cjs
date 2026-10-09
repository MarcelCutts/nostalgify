#!/usr/bin/env node
'use strict';

// Check esbuild's actual dependency graph, including external imports, rather
// than guessing from words in minified bundles or optional provider UI labels.
const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');

const root = path.resolve(__dirname, '..');
const failures = [];
const normalize = (value) => value.replaceAll('\\', '/');
const fail = (message) => failures.push(message);

function readJson(relative) {
  try { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); }
  catch (error) { fail(`${relative}: ${error.message}. Run npm run build first.`); return null; }
}

function pathsInGraph(meta) {
  const result = new Set(Object.keys(meta.inputs || {}));
  for (const item of [...Object.values(meta.inputs || {}), ...Object.values(meta.outputs || {})]) {
    for (const imported of item.imports || []) result.add(imported.path);
  }
  return [...result].map(normalize);
}

function checkGraph(platform) {
  const relative = `apps/${platform}/dist/metafile.json`;
  const meta = readJson(relative);
  if (!meta) return;
  if (!Object.keys(meta.inputs || {}).length || !Object.keys(meta.outputs || {}).length) {
    fail(`${relative}: missing esbuild inputs or outputs`);
    return;
  }
  const paths = pathsInGraph(meta);
  for (const entry of paths) {
    if (isBuiltin(entry) || /^(?:node|electron):/.test(entry) || /(?:^|\/)electron(?:\/|$)/.test(entry)) {
      fail(`${platform} renderer imports a desktop runtime: ${entry}`);
    }
    if (platform === 'ipad' && /(?:^|\/)(?:apps\/desktop|hls\.js|soundcloud)(?:\/|$)|soundcloudAudio\.[cm]?js$/.test(entry)) {
      fail(`iPad bundle includes a desktop/SoundCloud dependency: ${entry}`);
    }
    if (platform === 'desktop' && /(?:^|\/)(?:apps\/ipad|@capacitor)(?:\/|$)/.test(entry)) {
      fail(`desktop renderer includes an iPad dependency: ${entry}`);
    }
  }
  if (!paths.some((entry) => /(?:packages\/player-ui\/|@nostalgify\/player-ui(?:\/|$))/.test(entry))) {
    fail(`${platform} build does not include the shared player UI`);
  }
}

function walk(directory, visit, prefix = '') {
  if (!fs.existsSync(directory)) { fail(`Missing build directory: ${path.relative(root, directory)}`); return; }
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = normalize(path.join(prefix, item.name));
    if (item.isSymbolicLink()) { fail(`Build output contains a symlink: ${relative}`); continue; }
    visit(relative, item);
    if (item.isDirectory()) walk(path.join(directory, item.name), visit, relative);
  }
}

checkGraph('ipad');
checkGraph('desktop');

const stage = 'apps/desktop/dist';
const desktop = readJson(`${stage}/package.json`);
if (desktop) {
  const main = desktop.main;
  if (typeof main !== 'string' || path.isAbsolute(main) || main.split(/[\\/]/).includes('..')
      || !fs.existsSync(path.join(root, stage, main))) {
    fail('Desktop staging package has no contained, existing main entry');
  }
  for (const name of Object.keys({ ...desktop.dependencies, ...desktop.optionalDependencies })) {
    if (name.startsWith('@capacitor/') || name === '@nostalgify/ipad') fail(`Desktop staging dependency: ${name}`);
  }
}
walk(path.join(root, stage), (entry) => {
  if (/(?:^|\/)(?:ios|android|CapApp-SPM|apps|packages|\.github)(?:\/|$)|\.(?:swift|pbxproj|xcworkspace|xcodeproj|xcconfig)$/.test(entry)) {
    fail(`Desktop staging contains native/development project material: ${entry}`);
  }
});
walk(path.join(root, 'apps/ipad/dist'), (entry) => {
  if (/(?:^|\/)(?:node_modules|ios|src\/main|src\/preload)(?:\/|$)|\.(?:swift|pbxproj|xcconfig)$/.test(entry)) {
    fail(`iPad web assets contain native or Node sources: ${entry}`);
  }
});

if (failures.length) {
  console.error(`Build boundary checks failed:\n${failures.map((value) => `- ${value}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Build boundaries passed: shared UI, isolated renderer graphs, isolated desktop staging.');
}
