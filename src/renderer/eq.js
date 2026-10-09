// Neither provider uses Webamp's EQ processing. Keep the skin artwork, but show
// a flat, OFF display and make the unavailable controls honest and inert.
const CONTROLS = ".band, #on, #auto, #presets-context, #presets, #plus12db, #zerodb, #minus12db";
const FOCUSABLE = "input, button, select, [tabindex], [role='slider'], [role='button']";
const DESCRIPTION = {
  spotify: "Decorative equalizer. Spotify: use Spotify Settings > Playback > Equalizer.",
  soundcloud: "Decorative equalizer. EQ does not affect SoundCloud playback in Nostalgify.",
};

export function createEqPolicy(webamp, initialSkins) {
  const store = webamp.store;
  let hasEq = new Map(initialSkins.map((s) => [s.url, s.hasEq]));
  let panelAvailable = true;
  let autoClosed = false;
  let provider = "spotify";
  let resetting = false;
  let scheduled = false;

  function resetDisplay() {
    if (resetting) return;
    resetting = true;
    try {
      const eq = store.getState().equalizer;
      if (eq.on) store.dispatch({ type: "SET_EQ_OFF" });
      if (eq.auto) store.dispatch({ type: "SET_EQ_AUTO", value: false });
      for (const [band, value] of Object.entries(eq.sliders)) {
        if (value === 50) continue;
        store.dispatch({ type: "SET_BAND_VALUE", band: band === "preamp" ? band : Number(band), value: 50 });
      }
    } finally {
      resetting = false;
    }
  }

  function describeControls() {
    const panel = document.getElementById("equalizer-window");
    if (!panel) return;
    const description = DESCRIPTION[provider];
    panel.title = description;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "Equalizer (decorative)");
    panel.setAttribute("aria-description", description);
    for (const control of panel.querySelectorAll(CONTROLS)) {
      control.setAttribute("aria-disabled", "true");
      control.setAttribute("aria-description", description);
      control.title = description;
      const targets = [control, ...control.querySelectorAll(FOCUSABLE)];
      for (const target of targets) {
        target.setAttribute("aria-disabled", "true");
        target.setAttribute("aria-description", description);
        target.tabIndex = -1;
        if ("disabled" in target) target.disabled = true;
      }
    }
  }

  function scheduleDescription() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      describeControls();
    });
  }

  // React replaces controls when shading, reopening, or changing skin. Refresh
  // their native/ARIA disabled state after that render, without disabling the
  // working title-bar close/shade buttons or compact-mode volume slider.
  webamp.__onStateChange(() => {
    resetDisplay();
    scheduleDescription();
  });

  function isOpen() {
    return store.getState().windows.genWindows.equalizer.open;
  }

  return {
    canShowPanel: () => panelAvailable,
    setProvider(next) {
      const value = next === "soundcloud" ? "soundcloud" : "spotify";
      if (value === provider) return;
      provider = value;
      describeControls();
      scheduleDescription();
    },
    updateSkins(list) {
      hasEq = new Map(list.map((s) => [s.url, s.hasEq]));
    },
    // url is null for Webamp's built-in default skin, which has an equalizer.
    applyForSkin(url) {
      panelAvailable = url == null ? true : hasEq.get(url) !== false;
      document.body.classList.toggle("no-eq", !panelAvailable);
      if (!panelAvailable && isOpen()) {
        store.dispatch({ type: "CLOSE_WINDOW", windowId: "equalizer" });
        autoClosed = true;
      } else if (panelAvailable && autoClosed && !isOpen()) {
        store.dispatch({ type: "TOGGLE_WINDOW", windowId: "equalizer" });
        autoClosed = false;
      }
      resetDisplay();
      scheduleDescription();
    },
  };
}
