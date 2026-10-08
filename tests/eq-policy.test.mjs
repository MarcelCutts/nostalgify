import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  entryPoints: [new URL("../src/renderer/eq.js", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { createEqPolicy } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

function element({ input = false, children = [] } = {}) {
  const node = {
    attributes: {}, tabIndex: 0, title: "", children,
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return children; },
  };
  if (input) node.disabled = false;
  return node;
}

function harness(t) {
  const frames = [];
  const classes = new Set();
  const state = {
    equalizer: { on: true, auto: true, sliders: { preamp: 54, 60: 66, 170: 61, 1000: 45, 16000: 62 } },
    windows: { genWindows: { equalizer: { open: true } } },
  };
  let listener = () => {};
  let panel;
  function replaceControls() {
    const slider = element({ input: true });
    const band = element({ children: [slider] });
    const on = element();
    const presets = element({ children: [element({ input: true })] });
    // These working controls deliberately aren't among the decorative controls.
    const close = element(), shade = element(), volume = element({ input: true });
    panel = element({ children: [band, on, presets] });
    return { panel, band, slider, on, presets, close, shade, volume };
  }
  const oldDocument = globalThis.document;
  const oldRaf = globalThis.requestAnimationFrame;
  globalThis.document = {
    body: { classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } },
    getElementById: (id) => id === "equalizer-window" ? panel : null,
  };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  t.after(() => {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = oldRaf;
  });
  const store = {
    getState: () => state,
    dispatch(action) {
      if (action.type === "SET_EQ_OFF") state.equalizer.on = false;
      if (action.type === "SET_EQ_ON") state.equalizer.on = true;
      if (action.type === "SET_EQ_AUTO") state.equalizer.auto = action.value;
      if (action.type === "SET_BAND_VALUE") state.equalizer.sliders[action.band] = action.value;
      if (action.type === "CLOSE_WINDOW") state.windows.genWindows.equalizer.open = false;
      if (action.type === "TOGGLE_WINDOW") state.windows.genWindows.equalizer.open = !state.windows.genWindows.equalizer.open;
      listener();
    },
  };
  const policy = createEqPolicy({ store, __onStateChange(callback) { listener = callback; } }, [
    { url: "skin:with-eq", hasEq: true }, { url: "skin:no-eq", hasEq: false },
  ]);
  return { policy, state, store, classes, replaceControls, flush() { while (frames.length) frames.shift()(); } };
}

test("decorative EQ stays flat/OFF even if a preset or shortcut dispatches EQ changes", (t) => {
  const h = harness(t);
  h.policy.applyForSkin("skin:with-eq");
  assert.equal(h.state.equalizer.on, false);
  assert.equal(h.state.equalizer.auto, false);
  assert.ok(Object.values(h.state.equalizer.sliders).every((value) => value === 50));
  h.store.dispatch({ type: "SET_EQ_ON" });
  h.store.dispatch({ type: "SET_EQ_AUTO", value: true });
  h.store.dispatch({ type: "SET_BAND_VALUE", band: 60, value: 100 });
  assert.equal(h.state.equalizer.on, false);
  assert.equal(h.state.equalizer.auto, false);
  assert.equal(h.state.equalizer.sliders[60], 50);
  h.flush();
});

test("source-specific disabled semantics survive control replacement without disabling working window controls", (t) => {
  const h = harness(t);
  const first = h.replaceControls();
  h.policy.applyForSkin(null);
  h.flush();
  assert.match(first.panel.title, /Spotify Settings > Playback > Equalizer/);
  assert.equal(first.panel.attributes.role, "group");
  assert.equal(first.slider.disabled, true);
  assert.equal(first.slider.tabIndex, -1);
  assert.equal(first.slider.attributes["aria-disabled"], "true");
  assert.equal(first.on.tabIndex, -1);
  assert.equal(first.on.attributes["aria-disabled"], "true");

  h.policy.setProvider("soundcloud");
  const replacement = h.replaceControls();
  h.store.dispatch({ type: "WINDOW_SHADE_CHANGED" });
  h.flush();
  assert.match(replacement.panel.attributes["aria-description"], /SoundCloud equalizer is not implemented yet/);
  assert.match(replacement.slider.attributes["aria-description"], /SoundCloud/);
  assert.equal(replacement.slider.disabled, true);
  assert.equal(replacement.presets.children[0].tabIndex, -1);
  for (const control of [replacement.close, replacement.shade, replacement.volume]) {
    assert.equal(control.tabIndex, 0);
    assert.equal(control.attributes["aria-disabled"], undefined);
  }
  assert.equal(replacement.volume.disabled, false);
  h.policy.setProvider("spotify");
  assert.match(replacement.panel.title, /Spotify Settings/);
});

test("skins without EQ artwork close the panel and preserve the existing automatic reopening policy", (t) => {
  const h = harness(t);
  h.policy.applyForSkin("skin:no-eq");
  assert.equal(h.policy.allowed(), false);
  assert.equal(h.state.windows.genWindows.equalizer.open, false);
  assert.ok(h.classes.has("no-eq"));
  h.policy.applyForSkin("skin:with-eq");
  assert.equal(h.policy.allowed(), true);
  assert.equal(h.state.windows.genWindows.equalizer.open, true);
  assert.ok(!h.classes.has("no-eq"));
  h.store.dispatch({ type: "CLOSE_WINDOW", windowId: "equalizer" });
  h.policy.applyForSkin(null);
  assert.equal(h.state.windows.genWindows.equalizer.open, false, "A manually closed EQ must stay closed");
  h.flush();
});
