import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  entryPoints: [new URL("../packages/player-ui/src/eq.js", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { createEqPolicy } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

// Model the selector forms used by the policy, including descendants and
// reflected tabindex. Unknown forms fail rather than silently overmatching.
function element({ tag = "div", id, className, children = [] } = {}) {
  const node = {
    attributes: { ...(id ? { id } : {}), ...(className ? { class: className } : {}) },
    title: "", children,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    get tabIndex() { return this.attributes.tabindex == null ? (tag === "input" ? 0 : -1) : Number(this.attributes.tabindex); },
    set tabIndex(value) { this.attributes.tabindex = String(value); },
    matches(selector) {
      if (selector === "*") return true;
      if (/^#[\w-]+$/.test(selector)) return this.attributes.id === selector.slice(1);
      if (/^\.[\w-]+$/.test(selector)) return (this.attributes.class || "").split(/\s+/).includes(selector.slice(1));
      if (/^[a-z]+$/.test(selector)) return tag === selector;
      const attribute = selector.match(/^\[([\w-]+)(?:=['"]([^'"]+)['"])?\]$/);
      if (attribute) return attribute[2] == null
        ? Object.hasOwn(this.attributes, attribute[1])
        : this.attributes[attribute[1]] === attribute[2];
      throw new SyntaxError(`Unsupported fixture selector: ${selector}`);
    },
    querySelectorAll(selector) {
      const selectors = selector.split(",").map((part) => part.trim());
      if (selectors.some((part) => !part)) throw new SyntaxError("Empty selector");
      const found = [];
      function visit(parent) {
        for (const child of parent.children) {
          if (selectors.some((part) => child.matches(part))) found.push(child);
          visit(child);
        }
      }
      visit(this);
      return found;
    },
  };
  if (tag === "input") node.disabled = false;
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
  function replaceControls({ shaded = false } = {}) {
    // Webamp 2.3.1 uses div-based EQ controls. Close/shade live inside the
    // panel in both modes; only the shaded panel contains native range inputs.
    const close = element({ id: "equalizer-close" });
    const shade = element({ id: "equalizer-shade" });
    const titleButtons = element({ id: "eq-buttons", children: [shade, close] });
    const protectedControls = [titleButtons, close, shade];
    let content;
    let decorative = [];
    if (shaded) {
      const volume = element({ tag: "input", id: "equalizer-volume" });
      const balance = element({ tag: "input", id: "equalizer-balance" });
      protectedControls.push(volume, balance);
      content = element({ children: [titleButtons, volume, balance] });
    } else {
      const bands = ["preamp", 60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000].map((band) =>
        element({ id: band === "preamp" ? band : `band-${band}`, className: "band", children: [element({ children: [element()] })] })
      );
      const on = element({ id: "on" }), auto = element({ id: "auto" });
      const presets = element({ id: "presets" });
      const presetsContext = element({ id: "presets-context", children: [presets] });
      const levels = ["plus12db", "zerodb", "minus12db"].map((id) => element({ id }));
      const titleBar = element({ className: "equalizer-top", children: [titleButtons] });
      protectedControls.push(titleBar);
      decorative = [...bands, on, auto, presetsContext, presets, ...levels];
      content = element({ children: [
        titleBar,
        on, auto, element({ id: "eq-graph" }), presetsContext, bands[0], ...levels,
        element({ children: bands.slice(1) }),
      ] });
    }
    panel = element({ id: "equalizer-window", children: [content] });
    return { panel, decorative, protectedControls };
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

test("decorative EQ stays flat/OFF after direct EQ actions", (t) => {
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

function assertDecorativeControls(controls, provider) {
  for (const control of controls) {
    assert.equal(control.attributes["aria-disabled"], "true", control.attributes.id);
    assert.equal(control.tabIndex, -1, control.attributes.id);
    assert.match(control.attributes["aria-description"], provider);
  }
}

function assertProtectedControls(controls) {
  for (const control of controls) {
    assert.equal(control.attributes["aria-disabled"], undefined, control.attributes.id);
    assert.equal(control.attributes["aria-description"], undefined, control.attributes.id);
    assert.equal(control.attributes.tabindex, undefined, control.attributes.id);
    if ("disabled" in control) {
      assert.equal(control.disabled, false, control.attributes.id);
      assert.equal(control.tabIndex, 0, control.attributes.id);
    }
  }
}

test("source descriptions survive shade replacements and preserve window and compact controls", (t) => {
  const h = harness(t);
  const first = h.replaceControls();
  h.policy.applyForSkin(null);
  h.flush();
  assert.match(first.panel.title, /Spotify Settings > Playback > Equalizer/);
  assert.equal(first.panel.attributes.role, "group");
  assertDecorativeControls(first.decorative, /Spotify/);
  assertProtectedControls(first.protectedControls);

  h.policy.setProvider("soundcloud");
  h.flush(); // Finish the provider-change frame before testing the listener.
  const compact = h.replaceControls({ shaded: true });
  h.store.dispatch({ type: "TOGGLE_WINDOW_SHADE_MODE", windowId: "equalizer" });
  assert.equal(compact.panel.attributes["aria-description"], undefined);
  h.flush();
  assert.match(compact.panel.attributes["aria-description"], /EQ does not affect SoundCloud playback in Nostalgify/);
  assertProtectedControls(compact.protectedControls);

  const replacement = h.replaceControls();
  h.store.dispatch({ type: "TOGGLE_WINDOW_SHADE_MODE", windowId: "equalizer" });
  assert.equal(replacement.panel.attributes["aria-description"], undefined);
  assert.equal(replacement.decorative[0].attributes["aria-disabled"], undefined);
  h.flush();
  assert.match(replacement.panel.attributes["aria-description"], /EQ does not affect SoundCloud playback in Nostalgify/);
  assertDecorativeControls(replacement.decorative, /SoundCloud/);
  assertProtectedControls(replacement.protectedControls);
  h.policy.setProvider("spotify");
  assert.match(replacement.panel.title, /Spotify Settings/);
});

test("skins without EQ artwork close the panel and preserve the existing automatic reopening policy", (t) => {
  const h = harness(t);
  h.policy.applyForSkin("skin:no-eq");
  assert.equal(h.policy.canShowPanel(), false);
  assert.equal(h.state.windows.genWindows.equalizer.open, false);
  assert.ok(h.classes.has("no-eq"));
  h.policy.applyForSkin("skin:with-eq");
  assert.equal(h.policy.canShowPanel(), true);
  assert.equal(h.state.windows.genWindows.equalizer.open, true);
  assert.ok(!h.classes.has("no-eq"));
  h.store.dispatch({ type: "CLOSE_WINDOW", windowId: "equalizer" });
  h.policy.applyForSkin(null);
  assert.equal(h.state.windows.genWindows.equalizer.open, false, "A manually closed EQ must stay closed");
  h.flush();
});
