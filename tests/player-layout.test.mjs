import test from "node:test";
import assert from "node:assert/strict";
import { manageLayout } from "../packages/player-ui/src/layout.js";

test("native layout includes Winamp Double Size without counting the shell transform", t => {
  const original = { document: globalThis.document, window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame };
  t.after(() => Object.assign(globalThis, original));
  const frames = [], measured = [];
  let doubled = false;
  let notify;
  const windows = [
    ["main", "#main-window", 116, true],
    ["equalizer", "#equalizer-window", 116, true],
    ["playlist", "#playlist-window, #playlist-window-shade", 145, false],
  ];
  const elements = new Map(windows.map(([, selector, height, canDouble]) => [selector, {
    offsetWidth: 275, offsetHeight: height,
    classList: { contains: name => name === "doubled" && doubled && canDouble },
    getBoundingClientRect() { assert.fail("Outer CSS scaling must not enter native layout"); },
  }]));
  globalThis.document = { getElementById: () => ({ querySelector: selector => elements.get(selector) }), body: { classList: { toggle() {} } } };
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  const state = { windows: { genWindows: Object.fromEntries(windows.map(([key]) => [key, { position: { x: 0, y: 0 } }])) } };
  const store = {
    getState: () => state,
    dispatch(action) { for (const [key, position] of Object.entries(action.positions)) state.windows.genWindows[key].position = position; },
  };
  manageLayout({ store, __onStateChange(callback) { notify = callback; } }, { platform: "ios", layout: (...size) => measured.push(size) });
  frames.shift()();
  assert.deepEqual(measured.at(-1), [275, 377]);
  doubled = true;
  notify(); frames.shift()();
  assert.deepEqual(measured.at(-1), [550, 609]);
  assert.deepEqual(state.windows.genWindows.equalizer.position, { x: 0, y: 232 });
  assert.deepEqual(state.windows.genWindows.playlist.position, { x: 0, y: 464 });
  doubled = false;
  notify(); frames.shift()();
  assert.deepEqual(measured.at(-1), [275, 377]);
});
