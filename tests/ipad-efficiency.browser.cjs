#!/usr/bin/env node
'use strict';

// Real Webamp renderer and iPad shell, with a controlled native-plugin fixture.
// Timers are stepped explicitly so timing assertions do not depend on CI speed.
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { chromium, webkit, devices } = require('playwright');
const { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const engine = process.env.IPAD_SMOKE_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine), 'IPAD_SMOKE_BROWSER must be chromium or webkit');
const output = mkdtempSync(join(tmpdir(), 'nostalgify-efficiency-'));
const artifacts = resolve(process.env.IPAD_SMOKE_ARTIFACT_DIR || output, `efficiency-${engine}`);
mkdirSync(artifacts, { recursive: true });

const entry = `
import { mountPlayer } from './packages/player-ui/src/renderer.js';
import { PlaybackMedia, bridge, sendCommand } from './packages/player-ui/src/playbackMedia.js';
import { createNativeHost } from './apps/ipad/src/bridge.js';
const mode = new URLSearchParams(location.search).get('mode');
const f = window.__efficiency = { now: 10000, timing: [], reads: 0, commands: [], errors: [], order: [], intervals: [], bridge, sendCommand };
const realInterval = window.setInterval.bind(window);
window.setInterval = (callback, ms, ...args) => {
  if (ms !== 200 && ms !== 1000) return realInterval(callback, ms, ...args);
  f.intervals.push({ callback, ms, args });
  return -f.intervals.length;
};
performance.now = () => f.now;
f.tick = async (ms, advance = ms) => {
  f.now += advance;
  for (const timer of f.intervals.filter(timer => timer.ms === ms)) await timer.callback(...timer.args);
};
const setTiming = PlaybackMedia.prototype.setTiming;
PlaybackMedia.prototype.setTiming = function(elapsed, duration) {
  f.timing.push({ elapsed, duration });
  return setTiming.call(this, elapsed, duration);
};
let listener;
let state = { provider: 'local', running: true, state: 'paused', sequence: 10,
  position: 12, volume: 70, shuffle: false, repeat: false, error: null, message: '',
  track: { id: 'fixture-track', name: 'Efficiency fixture', artist: 'Fixture', album: '', duration: 120 },
  capabilities: { canSeek: true, canSetVolume: true, canSkipNext: true, canSkipPrevious: true, canShuffle: true, canRepeat: true } };
const snapshot = () => ({ ...structuredClone(state), position: state.position + (f.spotifyClock ? (f.now - f.spotifyClock) / 1000 : 0) });
f.setState = patch => Object.assign(state, patch);
f.emit = patch => { f.setState(patch); listener?.(snapshot()); };
const operations = {
  getPreferences: async () => ({ value: {} }),
  setPreferences: async () => ({}),
  listAudio: async () => ({ items: [] }),
  getDiagnostics: async () => ({ events: [] }),
  getState: async () => {
    f.reads++;
    f.order.push('read');
    if (f.failRead) { f.failRead = false; throw Object.assign(new Error('Fixture read failure'), { code: 'spotify_state_unavailable' }); }
    const value = snapshot();
    if (f.deferRead) {
      f.deferRead = false;
      return new Promise(resolve => { f.completeRead = () => { f.completeRead = null; resolve(value); }; });
    }
    return value;
  },
  command: async options => {
    f.commands.push(options.command);
    if (f.failCommand) { f.failCommand = false; throw Object.assign(new Error('Fixture command failure'), { code: 'spotify_restricted' }); }
    if (options.command === 'seek') state.position = options.arg;
    if (options.command === 'playpause') state.state = state.state === 'playing' ? 'paused' : 'playing';
    state.sequence++;
    return { state: snapshot() };
  },
};
const plugin = {
  ...operations,
  addListener: async (_event, callback) => {
    if (mode === 'listener-failure') throw new Error('Fixture native listener failure');
    listener = callback;
    return { remove: async () => { listener = undefined; } };
  },
};
f.plugin = plugin;
if (mode === 'shell') {
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
      return 'efficiency-fixture';
    },
  };
  import('./apps/ipad/src/main.js').then(() => { f.host = window.nostalgify; });
} else {
  (async () => {
    const host = f.host = createNativeHost(plugin, { debug: true, onError: error => f.errors.push(error.message) });
    await host.ready;
    // These hosts intentionally return snapshots without notifying subscribers.
    if (mode === 'desktop' || mode === 'no-fanout') host.getState = operations.getState;
    if (mode === 'desktop') { host.platform = 'desktop'; delete host.onStateChanged; }
    if (host.onStateChanged) {
      const subscribe = host.onStateChanged;
      host.onStateChanged = callback => { f.order.push('subscribe'); return subscribe(callback); };
    }
    Object.assign(host, { initSkins: async () => ({ skins: [], initial: null }), onSetSkin() {}, onSkinsChanged() {} });
    f.order = [];
    f.mounted = await mountPlayer(host);
    f.ready = true;
  })();
}
`;

(async () => {
  await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, sourcefile: 'efficiency-fixture.js' },
    outfile: join(output, 'app.js'), bundle: true, platform: 'browser', format: 'iife', target: ['safari17'],
    define: { __IPAD_DEVELOPMENT__: 'false' }, logLevel: 'silent' });
  const executablePath = engine === 'chromium' ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (!existsSync(chromium.executablePath()) && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) : undefined;
  const browser = await ({ chromium, webkit })[engine].launch({ headless: true, executablePath,
    args: engine === 'chromium' ? ['--no-sandbox', '--disable-crashpad-for-testing'] : [] });
  const errors = [], consoleErrors = [], consoleWarnings = [];
  const tests = [];
  let context, page;
  try {
    context = await browser.newContext({ ...devices['iPad Pro 11'] });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
      if (message.type() === 'warning') consoleWarnings.push(message.text());
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'efficiency.test') return route.abort();
      const paths = { '/app.js': join(output, 'app.js'), '/shell.css': join(root, 'apps/ipad/src/shell.css'),
        '/player.css': join(root, 'packages/player-ui/src/app.css') };
      if (url.pathname === '/') {
        const body = url.searchParams.get('mode') === 'shell' ? readFileSync(join(root, 'apps/ipad/index.html')) :
          '<!doctype html><html><head><link rel="stylesheet" href="/player.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>';
        return route.fulfill({ contentType: 'text/html', body });
      }
      const file = paths[url.pathname] || (url.pathname.startsWith('/assets/') && resolve(root, 'packages/player-ui/src', '.' + url.pathname));
      if (!file || !existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
      return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream', body: readFileSync(file) });
    });
    const open = async mode => {
      await page.goto(`https://efficiency.test/?mode=${mode}`);
      await page.waitForFunction(shell => shell ? document.documentElement.dataset.playerReady === 'true' :
        window.__efficiency?.ready && window.__efficiency.timing.length > 0, mode === 'shell');
    };
    const resetTiming = () => page.evaluate(() => { window.__efficiency.timing = []; });
    const timing = () => page.evaluate(() => window.__efficiency.timing);
    const elapsed = () => page.evaluate(() => window.__efficiency.bridge.media.timeElapsed());

    await open('native');
    assert.deepEqual(await page.evaluate(() => window.__efficiency.order), ['subscribe', 'read'], 'Subscribe before the initial renderer refresh');
    assert.deepEqual(await timing(), [{ elapsed: 12, duration: 120 }], 'Initial fanout and return apply once');
    await resetTiming();
    await page.evaluate(() => window.__efficiency.mounted.refresh());
    assert.deepEqual(await timing(), [{ elapsed: 12, duration: 120 }], 'An ordinary native refresh applies one timeupdate');
    assert.deepEqual(await page.evaluate(() => window.__efficiency.intervals.map(timer => timer.ms)), [200, 1000], 'Both existing renderer intervals remain installed');
    tests.push('subscription before initial refresh; one timing update per native fanout/return');

    for (const mode of ['desktop', 'no-fanout', 'listener-failure']) {
      await open(mode);
      await resetTiming();
      const before = await page.evaluate(() => window.__efficiency.reads);
      await page.evaluate(async () => { const f = window.__efficiency; f.setState({ position: 17 }); await f.tick(1000); });
      assert.equal(await page.evaluate(() => window.__efficiency.reads), before + 1, `${mode}: the scheduled read stays active`);
      assert.deepEqual(await timing(), [{ elapsed: 17, duration: 120 }], `${mode}: a read without native events still updates the renderer`);
    }
    tests.push('scheduled fallback for desktop, subscriptions without read fanout, and failed native listener installation');

    await open('native');
    await resetTiming();
    await page.evaluate(async () => { const f = window.__efficiency; f.setState({ position: 20 }); await f.mounted.refresh(); f.setState({ position: 21 }); await f.mounted.refresh(); });
    assert.deepEqual((await timing()).map(value => value.elapsed), [20, 21], 'Equal-sequence snapshots can advance their position');
    await resetTiming();
    await page.evaluate(() => { const f = window.__efficiency; f.deferRead = true; f.pendingPoll = f.mounted.refresh(); });
    await page.waitForFunction(() => Boolean(window.__efficiency.completeRead));
    await page.evaluate(async () => { const f = window.__efficiency; f.emit({ position: 33, sequence: 11 }); f.completeRead(); await f.pendingPoll; });
    assert.deepEqual(await timing(), [{ elapsed: 33, duration: 120 }], 'A newer push wins over a stale in-flight read without reapplication');
    assert.equal(await elapsed(), 33);
    tests.push('equal-sequence progress; newer native push wins over stale read');

    await resetTiming();
    await page.evaluate(() => window.__efficiency.emit({ state: 'playing', position: 40, sequence: 12 }));
    await page.evaluate(async () => { const f = window.__efficiency; await f.tick(200); await f.tick(200); });
    assert.equal(await elapsed(), 40, 'Local playback never extrapolates between measured updates');
    await page.evaluate(() => { const f = window.__efficiency; f.now += 100; f.emit({ position: 40.5, sequence: 13 }); });
    await page.evaluate(async () => { const f = window.__efficiency; await f.tick(200); await f.tick(200); f.now += 100; f.emit({ position: 41, sequence: 14 }); });
    assert.deepEqual((await timing()).map(value => value.elapsed), [40, 40.5, 41], 'Two measured native updates per second remain authoritative');
    tests.push('local measured 2 Hz progress with no interpolation');

    await resetTiming();
    await page.evaluate(async () => { const f = window.__efficiency; await f.host.command('seek', 45); });
    assert.deepEqual(await timing(), [{ elapsed: 45, duration: 120 }], 'A command reply without an event remains observable');
    await page.evaluate(async () => { const f = window.__efficiency; f.failCommand = true; await f.sendCommand('seek', 50); });
    assert.match(await page.locator('#marquee').textContent(), /Playback command failed/i, 'Rejected commands remain visible in Webamp');
    assert.match(await page.evaluate(() => window.__efficiency.errors.at(-1)), /does not currently allow/);
    tests.push('command reply delivery and visible command rejection');

    await open('shell');
    await page.evaluate(() => { const f = window.__efficiency; f.spotifyClock = f.now; f.emit({ provider: 'spotify', state: 'playing', position: 60 }); f.timing = []; });
    assert.equal(await page.locator('#elapsed').textContent(), '1:00');
    const before = await page.evaluate(() => window.__efficiency.reads);
    for (let tick = 0; tick < 5; tick++) await page.evaluate(() => window.__efficiency.tick(200));
    const positions = (await timing()).map(value => value.elapsed);
    assert.equal(positions.length, 5, 'Spotify keeps the 200 ms classic-player clock');
    for (let index = 0; index < positions.length; index++) assert.ok(Math.abs(positions[index] - (60 + (index + 1) / 5)) < 0.001);
    assert.equal(await page.locator('#elapsed').textContent(), '1:00', 'The accessible shell waits for authoritative snapshots');
    await page.evaluate(() => window.__efficiency.tick(1000, 0));
    assert.equal(await page.evaluate(() => window.__efficiency.reads), before + 1);
    assert.equal(await page.locator('#elapsed').textContent(), '1:01', 'The unchanged 1 Hz poll advances the accessible Spotify clock');
    assert.equal(await page.locator('#seek').inputValue(), '61');
    tests.push('Spotify 200 ms interpolation and 1 Hz accessible shell clock');

    await page.evaluate(async () => { const f = window.__efficiency; f.failRead = true; await f.tick(1000); });
    assert.equal(await page.locator('#error-message').isVisible(), true, 'A rejected read remains visible in the shell');
    assert.match(await page.locator('#error-message').textContent(), /playback state is unavailable/i);
    const readsAfterFailure = await page.evaluate(() => window.__efficiency.reads);
    await page.evaluate(() => window.__efficiency.tick(1000));
    assert.equal(await page.evaluate(() => window.__efficiency.reads), readsAfterFailure + 1, 'Polling recovers after a rejected read');
    assert.equal(await page.locator('#elapsed').textContent(), '1:03');
    assert.equal(await page.locator('#error-message').isVisible(), true, 'A successful background read does not hide the operation warning');
    tests.push('visible read failure and subsequent scheduled recovery');

    await page.evaluate(() => window.__efficiency.emit({ running: false, error: 'spotify_disconnected', message: 'Reconnect fixture Spotify.', sequence: 11 }));
    assert.match(await page.locator('#marquee').textContent(), /Reconnect fixture Spotify/i, 'An authoritative playback error reaches the renderer');
    await page.evaluate(async () => {
      const f = window.__efficiency;
      f.spotifyClock = null;
      f.setState({ running: true, error: null, message: '', position: 70, sequence: 12 });
      await f.tick(1000);
    });
    assert.equal(await elapsed(), 70, 'A healthy read restores timing after a playback error');
    assert.doesNotMatch(await page.locator('#marquee').textContent(), /Reconnect fixture Spotify/i, 'A healthy read clears the playback error');
    tests.push('authoritative playback error and healthy snapshot recovery');

    assert.deepEqual(errors, [], 'No browser exceptions');
    const expectedReadErrors = consoleErrors.filter(message => /Spotify playback state is unavailable/.test(message));
    assert.equal(expectedReadErrors.length, 1, 'The deliberate rejected poll is logged once');
    assert.deepEqual(consoleErrors.filter(message => !expectedReadErrors.includes(message)), [], 'No unexpected browser console errors');
    await page.screenshot({ path: join(artifacts, 'efficiency.png'), fullPage: true });
    const report = { pass: true, engine, browser: browser.version(), tests, expectedReadErrors, consoleWarnings, actualIPad: false, actualAudio: false, artifacts };
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await context.tracing.stop();
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
    await context?.tracing.stop({ path: join(artifacts, 'trace.zip') }).catch(() => {});
    writeFileSync(join(artifacts, 'failure.log'), `${error.stack}\n${[...errors, ...consoleErrors, ...consoleWarnings].join('\n')}`);
    throw error;
  } finally { await context?.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
