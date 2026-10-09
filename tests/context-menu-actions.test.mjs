import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  entryPoints: [new URL("../src/renderer/contextMenu.js", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { installContextMenus } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

function harness(t) {
  const listeners = new Map(), actions = [], menus = [], playback = [];
  const state = {
    windows: { genWindows: { equalizer: { open: true }, playlist: { open: true } } },
    media: { timeMode: "ELAPSED", shuffle: false, repeat: false }, display: { doubled: false },
    playlist: { trackOrder: [1, 2, 3], selectedTracks: [], currentTrack: 100 },
    tracks: { 1: { title: "C" }, 2: { title: "A" }, 3: { title: "B" }, 100: { title: "Playing metadata" } },
  };
  class Element {
    constructor({ inside = true, id = "" } = {}) { this.inside = inside; this.id = id; }
    closest(selector) {
      return selector === "#webamp" ? (this.inside ? this : null)
        : (selector.split(",").includes(`#${this.id}`) ? this : null);
    }
  }
  const original = { window: globalThis.window, Element: globalThis.Element };
  let menuAction;
  globalThis.Element = Element;
  globalThis.window = {
    addEventListener(type, callback, capture) { listeners.set(type, { callback, capture }); },
    nostalgify: {
      showContextMenu(kind, menuState) { menus.push({ kind, state: menuState }); },
      onMenuAction(callback) { menuAction = callback; },
    },
  };
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  let available = true;
  installContextMenus({
    webamp: { store: { getState: () => state, dispatch: (action) => actions.push(action) }, stop: () => playback.push("bridgeStop") },
    shelf: { handleAddUrl: () => playback.push("addUrl") },
    eq: { canShowPanel: () => available }, transport: (action) => playback.push(action),
  });
  function event(type, fields = {}) {
    const result = {
      target: new Element(), button: 0, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...fields,
    };
    listeners.get(type)?.callback(result);
    return result;
  }
  return { state, actions, menus, playback, listeners, Element, event,
    action: (name) => menuAction(name), setEqAvailable(value) { available = value; } };
}

test("right-mousedown is captured inside Webamp before dragging, without suppressing the native menu", (t) => {
  const h = harness(t);
  assert.equal(h.listeners.get("mousedown")?.capture, true);
  const down = h.event("mousedown", { button: 2 });
  assert.equal(down.stopped, true);
  assert.equal(down.prevented, false, "the browser must still generate contextmenu");
  for (const fields of [{ button: 0 }, { button: 1 }, { button: 2, target: new h.Element({ inside: false }) }, { button: 2, target: {} }]) {
    const allowed = h.event("mousedown", fields);
    assert.equal(allowed.stopped, false, "other buttons and targets retain normal input");
    assert.equal(allowed.prevented, false);
  }
  h.event("contextmenu", { button: 2 });
  assert.equal(h.menus.at(-1).kind, "main");
  const outside = h.event("contextmenu", { target: new h.Element({ inside: false }) });
  assert.equal(outside.prevented, false);
  assert.equal(h.menus.length, 1);
});

test("menu state and removal use only selection IDs still on the shelf", (t) => {
  const h = harness(t);
  h.state.playlist.selectedTracks = [9];
  h.event("contextmenu");
  assert.equal(h.menus.at(-1).state.hasSelection, false);
  h.state.playlist.selectedTracks = [2, 9];
  h.event("contextmenu");
  assert.equal(h.menus.at(-1).state.hasSelection, true);
  h.action("removeSelected");
  assert.deepEqual(h.actions, [{ type: "REMOVE_TRACKS", ids: [2] }, { type: "SELECT_ZERO" }]);
});

test("a delayed crop callback cannot clear a shelf whose selection was removed", (t) => {
  const h = harness(t);
  h.state.playlist.selectedTracks = [2];
  h.event("contextmenu");
  assert.equal(h.menus.at(-1).state.hasSelection, true);
  h.state.playlist.trackOrder = [1, 3];
  h.action("keepOnlySelected");
  assert.deepEqual(h.actions, [], "removed IDs are no longer a crop target");
  h.state.playlist.selectedTracks = [];
  h.action("keepOnlySelected");
  assert.deepEqual(h.actions, [], "an empty selection is also harmless");
  h.state.playlist.selectedTracks = [3, 9];
  h.action("keepOnlySelected");
  assert.deepEqual(h.actions, [{ type: "REMOVE_TRACKS", ids: [1] }, { type: "SELECT_ZERO" }]);
});

test("Clear Shelf removes shelf rows without removing the playing metadata track", (t) => {
  const h = harness(t);
  h.action("clearShelf");
  assert.deepEqual(h.actions, [{ type: "REMOVE_TRACKS", ids: [1, 2, 3] }, { type: "SELECT_ZERO" }]);
  assert.ok(!h.actions[0].ids.includes(h.state.playlist.currentTrack));
});

test("menu commands use the media bridge and recheck EQ availability at action time", (t) => {
  const h = harness(t);
  for (const action of ["play", "pause", "previous", "next", "stop", "openCurrentSource", "addMusicLink"]) h.action(action);
  assert.deepEqual(h.playback, ["playOrFallback", "pause", "previous", "next", "bridgeStop", "activate", "addUrl"]);
  h.event("contextmenu");
  assert.equal(h.menus.at(-1).state.equalizerPanelAvailable, true);
  h.setEqAvailable(false);
  h.action("toggleEqualizerPanel");
  assert.deepEqual(h.actions, [], "a stale enabled item must not open an unavailable panel");
  h.setEqAvailable(true);
  h.action("toggleEqualizerPanel");
  assert.deepEqual(h.actions, [{ type: "TOGGLE_WINDOW", windowId: "equalizer" }]);
});
