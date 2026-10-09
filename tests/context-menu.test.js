const test = require("node:test");
const assert = require("node:assert/strict");
const { contextMenuTemplate } = require("../src/main/context-menu");

const dependencies = { action() {}, skinMenu: [], zoomMenu: [] };
test("native menu requests accept only known contexts and literal boolean state", () => {
  for (const kind of ["file", "constructor", {}, null]) assert.deepEqual(contextMenuTemplate(kind, {}, dependencies), []);
  for (const state of [null, [], "main"]) assert.deepEqual(contextMenuTemplate("main", state, dependencies), []);
  const menu = contextMenuTemplate("main", { equalizerPanelAvailable: "true", equalizerPanelOpen: 1, playlistOpen: {} }, dependencies);
  const eq = menu.find((item) => item.label === "Equalizer Panel");
  assert.equal(eq.enabled, false);
  assert.equal(eq.checked, false);
  assert.equal(menu.find((item) => item.label === "Playlist Editor").checked, false);
});

test("renderer input cannot supply native roles, labels, callbacks, or executable commands", () => {
  const calls = [];
  const menu = contextMenuTemplate("main", { role: "quit", label: "injected", click: "injected", submenu: [{ label: "injected" }] }, {
    ...dependencies, action: (action) => calls.push(action),
  });
  const playback = menu.find((item) => item.label === "Playback").submenu;
  for (const item of playback) item.click?.();
  assert.deepEqual(calls, ["previous", "play", "pause", "stop", "next", "toggleShuffle", "toggleRepeat", "openCurrentSource"]);
  assert.equal(JSON.stringify(menu).includes("injected"), false);
});

test("destructive selection operations stay disabled without a selection", () => {
  for (const hasSelection of [false, undefined, "true"]) {
    const menu = contextMenuTemplate("remove", { hasSelection }, dependencies);
    assert.equal(menu[0].enabled, false);
    assert.equal(menu[1].enabled, false);
  }
  assert.equal(contextMenuTemplate("remove", { hasSelection: true }, dependencies)[0].enabled, true);
});
