import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackMedia, bridge } from "../packages/player-ui/src/playbackMedia.js";
import { createShelf } from "../packages/player-ui/src/shelf.js";

test("native playback never creates a browser audio graph and transport stays on the host", async (t) => {
  const original = { AudioContext: globalThis.AudioContext, host: bridge.host };
  const commands = [];
  globalThis.AudioContext = class { constructor() { throw new Error("Native playback must not start Web Audio"); } };
  bridge.host = { fakeVisualization: false, command: async (...args) => { commands.push(args); } };
  t.after(() => { globalThis.AudioContext = original.AudioContext; bridge.host = original.host; bridge.media = null; });
  const media = new PlaybackMedia();
  media.setVisualizerPlaying(true);
  const frequencies = new Uint8Array(4).fill(99);
  media.getAnalyser().getByteFrequencyData(frequencies);
  assert.deepEqual([...frequencies], [0, 0, 0, 0]);
  await media.play();
  media.stop();
  await new Promise(setImmediate);
  assert.deepEqual(commands, [["play", undefined], ["stop", undefined]]);
});

test("native shelf retains imported files, omits unavailable Liked Songs, and plays local IDs through the host", async (t) => {
  const original = { window: globalThis.window, document: globalThis.document, host: bridge.host };
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener() {} };
  t.after(() => { globalThis.window = original.window; globalThis.document = original.document; bridge.host = original.host; });
  const local = { provider: "local", kind: "track", uri: "local:40f1e23c-fb7c-46ad-9a8e-df69c8db6aa1", title: "My recording" };
  const commands = [], actions = [], trackOrder = [];
  const host = {
    supportsLikedSongs: false,
    loadShelf: async () => [{ kind: "liked", uri: "liked" }, local],
    saveShelf: async () => {},
    command: async (...args) => { commands.push(args); },
  };
  bridge.host = host;
  const webamp = { store: {
    getState: () => ({ playlist: { trackOrder } }),
    dispatch(action) {
      actions.push(action);
      if (action.type === "ADD_TRACK_FROM_URL") trackOrder.push(action.id);
      if (action.type === "REMOVE_TRACKS") {
        for (const id of action.ids) { const index = trackOrder.indexOf(id); if (index >= 0) trackOrder.splice(index, 1); }
      }
    },
  } };
  const shelf = createShelf(webamp, { host, quietly: (fn) => fn(), flash() {}, onPlay() {} });
  await shelf.load();
  const rows = actions.filter((action) => action.type === "ADD_TRACK_FROM_URL");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, `shelf:${local.uri}`);
  assert.equal(rows[0].defaultName, "My recording");
  shelf.onAction({ type: "PLAY_TRACK", id: rows[0].id }, false);
  await new Promise(setImmediate);
  assert.deepEqual(commands, [["playShelf", local.uri]]);
  assert.deepEqual(shelf.addItems([local, local]), []);
  assert.equal(trackOrder.length, 1);
  shelf.removeUri(local.uri);
  assert.equal(trackOrder.length, 0);
  assert.equal(shelf.isShelfTrack(rows[0].id), false);
});

test("shelf paste preserves editable controls and still adds global Spotify links", async (t) => {
  const original = { window: globalThis.window, document: globalThis.document };
  const listeners = new Map();
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener(name, listener) { listeners.set(name, listener); } };
  t.after(() => { globalThis.window = original.window; globalThis.document = original.document; });
  const resolved = [], added = [], trackOrder = [];
  const host = {
    resolveLinks: async text => {
      resolved.push(text);
      return [{ provider: "spotify", kind: "track", uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC", title: "Saved track" }];
    },
    saveShelf: async () => {},
  };
  createShelf({ store: {
    getState: () => ({ playlist: { trackOrder } }),
    dispatch(action) {
      if (action.type === "ADD_TRACK_FROM_URL") { added.push(action); trackOrder.push(action.id); }
    },
  } }, { host, quietly: fn => fn(), flash() {}, onPlay() {} });
  const paste = listeners.get("paste");
  const clipboardData = { getData: () => "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" };
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    const target = { isContentEditable: false, closest: selector => selector.split(", ").includes(tagName.toLowerCase()) ? target : null };
    paste({ target, clipboardData, preventDefault() { assert.fail(`Paste was prevented in ${tagName}`); } });
  }
  paste({ target: { isContentEditable: true }, clipboardData, preventDefault() { assert.fail("Paste was prevented in contenteditable"); } });
  paste({ target: {}, composedPath: () => [{ isContentEditable: true }], clipboardData, preventDefault() { assert.fail("Paste was prevented inside an editable shadow root"); } });
  await new Promise(setImmediate);
  assert.deepEqual(resolved, []);
  assert.deepEqual(added, []);

  let prevented = false;
  paste({ target: {}, clipboardData, preventDefault() { prevented = true; } });
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  assert.deepEqual(resolved, [clipboardData.getData()]);
  assert.equal(added.length, 1);
});
