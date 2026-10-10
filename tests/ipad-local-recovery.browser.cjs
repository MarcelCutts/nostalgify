#!/usr/bin/env node
'use strict';

// Production shell with a disposable native bridge fixture. This verifies the
// accessible control at cold launch; native audio behavior lives in XCTest.
const assert = require('node:assert/strict');
const { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');
const { chromium, webkit, devices } = require('playwright');

const root = resolve(__dirname, '..');
const directory = resolve(root, 'apps/ipad/dist');
const engine = process.env.IPAD_SMOKE_BROWSER || process.env.BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine), 'IPAD_SMOKE_BROWSER must be chromium or webkit');
assert.ok(existsSync(resolve(directory, 'index.html')), 'Run npm run build:ipad first');
const artifacts = resolve(process.env.IPAD_SMOKE_ARTIFACT_DIR || mkdtempSync(resolve(tmpdir(), 'nostalgify-local-recovery-')), `local-recovery-${engine}`);
mkdirSync(artifacts, { recursive: true });

(async () => {
  const browser = await ({ chromium, webkit })[engine].launch({ headless: true });
  let context, page;
  const errors = [];
  try {
    context = await browser.newContext({ ...devices['iPad Pro 11'] });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const key = 'local-recovery-fixture';
      let items = JSON.parse(localStorage.getItem(key) || '[]');
      let listener;
      const state = { provider: 'local', running: true, state: 'stopped',
        track: null, position: 0, volume: 70, shuffle: false, repeat: false,
        error: null, message: items.length ? '' : 'Import audio from Files to start listening.',
        sequence: 0, capabilities: { canSeek: false, canSetVolume: true,
          canSkipNext: false, canSkipPrevious: false, canShuffle: true, canRepeat: true } };
      const snapshot = () => structuredClone(state);
      const publish = () => { state.sequence++; listener?.(snapshot()); };
      window.__localRecoveryCommands = [];
      const operations = {
        getState: () => snapshot(),
        getPreferences: () => ({ value: {} }),
        setPreferences: () => ({}),
        listAudio: () => {
          if (window.__localRecoveryFailListAudio) {
            window.__localRecoveryFailListAudio = false;
            throw Object.assign(new Error('Fixture library refresh failure'), { code: 'native_error' });
          }
          return { items: structuredClone(items) };
        },
        getDiagnostics: () => ({ events: [] }),
        importAudio: () => {
          const partial = items.length > 0;
          const id = partial ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111';
          const item = { id, uri: `local:${id}`, name: partial ? 'Saved before storage failure' : 'Restored recording', artist: 'Fixture', album: '', duration: 30 };
          items.push(item);
          localStorage.setItem(key, JSON.stringify(items));
          state.message = '';
          publish();
          if (partial) throw Object.assign(new Error('Fixture storage failure after one saved file'), { code: 'library_write_failed' });
          return { items, skipped: 0, cancelled: false };
        },
        command: ({ command }) => {
          window.__localRecoveryCommands.push(command);
          if (command === 'playpause') {
            if (!items.length) throw Object.assign(new Error('Empty fixture'), { code: 'empty_library' });
            state.track = items[0];
            state.state = state.state === 'playing' ? 'paused' : 'playing';
          }
          publish();
          return { state: snapshot() };
        },
      };
      window.CapacitorCustomPlatform = { name: 'ios' };
      window.Capacitor = {
        PluginHeaders: [{ name: 'NostalgifyNative', methods: [
          ...Object.keys(operations).map(name => ({ name, rtype: 'promise' })),
          { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'callback' },
        ] }],
        nativePromise: async (_plugin, method, options) => operations[method](options),
        nativeCallback: async (_plugin, method, _options, callback) => {
          if (method === 'addListener') listener = callback;
          if (method === 'removeListener') listener = undefined;
          return 'local-fixture';
        },
      };
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'local-recovery.test') return route.abort();
      const file = resolve(directory, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(directory + '/') || !existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
      const contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto('https://local-recovery.test/');
    await page.waitForFunction(() => document.documentElement.dataset.playerReady === 'true');
    assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isDisabled(), true, 'An empty Files library cannot play');
    await page.locator('#local-source').click();
    await page.locator('#import-button').click();
    await page.waitForFunction(() => !document.getElementById('play-button').disabled);
    assert.equal(await page.evaluate(() => window.nostalgify.getCachedState().track), null, 'Importing does not select a row');

    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.playerReady === 'true');
    assert.equal(await page.evaluate(() => window.nostalgify.getCachedState().track), null, 'Relaunch begins with no selected track');
    assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isEnabled(), true, 'Restored audio is playable without selecting a row');
    assert.doesNotMatch(await page.locator('#player-status').textContent(), /import audio/i);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.nostalgify.getCachedState().state === 'playing');
    assert.deepEqual(await page.evaluate(() => window.__localRecoveryCommands), ['playpause'], 'The accessible button starts playback directly');
    await page.locator('#local-source').click();
    await page.locator('#import-button').click();
    await page.getByRole('button', { name: 'Play Saved before storage failure', exact: true }).waitFor();
    await page.waitForFunction(() => !document.getElementById('error-message').hidden);
    assert.match(await page.locator('#error-message').textContent(), /Check available iPad storage/);
    assert.equal(await page.locator('#local-library .music-row').count(), 2, 'Files saved before a later storage failure remain visible');
    assert.equal(await page.locator('#player-status').textContent(), 'Playing', 'An operation warning does not pin playback status');
    await page.evaluate(() => { window.__localRecoveryFailListAudio = true; });
    await page.locator('#import-button').click();
    await page.waitForFunction(() => !window.__localRecoveryFailListAudio && document.getElementById('import-button').getAttribute('aria-busy') !== 'true');
    assert.match(await page.locator('#error-message').textContent(), /Check available iPad storage/, 'A failed refresh cannot replace the import storage error');
    const failures = await page.evaluate(async () => (await window.nostalgify.getDiagnostics()).web.filter(event => event.event === 'failure').map(event => event.code));
    assert.deepEqual(failures.slice(-2), ['library_write_failed', 'native_error'], 'Both the import and refresh failures remain in diagnostics');
    assert.deepEqual(errors, [], 'No browser exceptions');
    const report = { pass: true, engine, artifacts, tests: ['empty library eligibility', 'eligibility after import', 'restored library accessible Play without a row tap', 'partial storage failure refresh and actionable operation warning', 'refresh failure preserves original warning and both diagnostics'], actualAudio: false };
    writeFileSync(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    await context.tracing.stop();
  } catch (error) {
    await page?.screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
    await context?.tracing.stop({ path: resolve(artifacts, 'trace.zip') }).catch(() => {});
    writeFileSync(resolve(artifacts, 'failure.log'), `${error.stack}\n${errors.join('\n')}`);
    throw error;
  } finally {
    await context?.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
