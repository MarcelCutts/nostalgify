// Webamp's sprite controls are divs. Keep their original handlers and artwork,
// while exposing actual actions and complete readouts to iPad accessibility APIs.
export function installSkinAccessibility(root) {
  const setAttribute = (element, name, value) => {
    if (!element || element.getAttribute(name) === value) return;
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  };
  const bitmapReadouts = "#kbps, #khz, #time, .mini-time";
  const decorativeEQ = ".band, #on, #auto, #presets-context, #presets, #plus12db, #zerodb, #minus12db";
  const menus = {
    "playlist-add-menu": "Add music to playlist",
    "playlist-remove-menu": "Rem: Remove playlist items",
    "playlist-selection-menu": "Sel: Select playlist items",
    "playlist-misc-menu": "Misc: Playlist options",
    "playlist-list-menu": "List opts: Playlist lists",
  };
  const options = {
    "add-url": "Add URL from clipboard", "add-dir": "Add dir: Choose audio files", "add-file": "Add file from Files",
    "remove-misc": "Remove miscellaneous (unavailable)", "remove-all": "Remove all", crop: "Crop to selected items", "remove-selected": "Remove selected",
    "invert-selection": "Invert selection", "select-zero": "Select none", "select-all": "Select all",
    "sort-list": "Sort list", "file-info": "File info (unavailable)", "misc-options": "Misc options",
    "new-list": "New list", "save-list": "Save list", "load-list": "Load list",
  };
  const buttons = {
    "#previous": "Main classic player: Previous track", "#play": "Main classic player: Play", "#pause": "Main classic player: Pause",
    "#stop": "Main classic player: Stop", "#next": "Main classic player: Next track", "#eject": "Main classic player: Open music",
    "#equalizer-button": "EQ: Toggle equalizer", "#playlist-button": "PL: Toggle playlist", "#shade": "Toggle compact player",
    "#equalizer-shade": "Toggle compact equalizer", "#equalizer-close": "Close equalizer",
    "#shuffle": "Main classic player: Shuffle", "#repeat": "Main classic player: Repeat",
    "#playlist-shade-button": "Toggle compact playlist", "#playlist-close-button": "Close playlist",
    "#playlist-scroll-up-button": "Scroll playlist up", "#playlist-scroll-down-button": "Scroll playlist down",
    ".playlist-previous-button": "Classic player: Previous track", ".playlist-play-button": "Classic player: Play", ".playlist-pause-button": "Classic player: Pause",
    ".playlist-stop-button": "Classic player: Stop", ".playlist-next-button": "Classic player: Next track", ".playlist-eject-button": "Classic player: Open music",
  };
  let contextOpener;
  const setControl = (element, label, role = "button") => {
    setAttribute(element, "role", role);
    setAttribute(element, "aria-label", label);
    setAttribute(element, "tabindex", role === "menuitem" ? "-1" : "0");
    setAttribute(element, "data-skin-control", "true");
  };
  const describeReadout = (element, label) => {
    setAttribute(element, "aria-hidden", null);
    setAttribute(element, "role", "img");
    setAttribute(element, "aria-label", label);
    for (const child of element.children) setAttribute(child, "aria-hidden", "true");
  };
  const describeArtwork = (parent, kind, label) => {
    if (!parent) return;
    let image = parent.querySelector(`:scope > [data-skin-artwork="${kind}"]`);
    if (!image) {
      image = document.createElement("span");
      image.dataset.skinArtwork = kind;
      parent.append(image);
    }
    describeReadout(image, label);
  };
  function update() {
    setAttribute(root.querySelector('#webamp[role="application"]'), "aria-label", "Classic Winamp player");
    const windows = [
      [root.querySelector('#main-window > [tabindex="-1"]'), "Main player window"],
      [root.querySelector('#equalizer-window > [tabindex="-1"]'), "Equalizer window"],
      [root.querySelector("#playlist-window")?.parentElement || root.querySelector("#playlist-window-shade"), "Playlist window"],
    ];
    for (const [element, label] of windows) {
      if (!element || (element.getAttribute("tabindex") !== "-1" && element.id !== "playlist-window-shade")) continue;
      // Webamp programmatically focuses these containers when a sprite is
      // replaced. Name that focus destination without changing its behavior.
      setAttribute(element, "role", "group");
      setAttribute(element, "aria-label", label);
    }
    // Avoid exposing individual off-screen glyphs where the shell supplies full
    // current-track/status text and spoken playback time.
    for (const element of root.querySelectorAll(bitmapReadouts)) setAttribute(element, "aria-hidden", "true");
    for (const element of root.querySelectorAll("#marquee")) {
      const text = element.textContent;
      // Webamp repeats long messages around this separator for animation. Only
      // remove an exact repeated copy; a real title may itself contain ***.
      const separator = "  ***  ", half = (text.length - separator.length) / 2;
      const repeated = Number.isInteger(half) && text.slice(half, half + separator.length) === separator && text.slice(0, half) === text.slice(half + separator.length);
      describeReadout(element, `Classic player display: ${(repeated ? text.slice(0, half) : text).trimEnd()}`);
    }
    describeArtwork(root.querySelector("#title-bar"), "title", "Winamp");
    describeArtwork(root.querySelector(".equalizer-top"), "title", "Winamp equalizer");
    const equalizerBody = root.querySelector(".equalizer-top")?.parentElement;
    describeArtwork(equalizerBody, "equalizer", "Equalizer artwork: On, Auto, Presets, preamp and frequency bands. These decorative controls do not affect playback.");
    // EQ artwork has no audio effect; preserve its description and window actions.
    for (const element of root.querySelector("#equalizer-window")?.querySelectorAll(decorativeEQ) || []) setAttribute(element, "aria-hidden", "true");
    for (const [selector, label] of Object.entries(buttons)) for (const element of root.querySelectorAll(selector)) setControl(element, label);
    for (const element of root.querySelectorAll("#equalizer-button, #playlist-button, #shuffle, #repeat")) setAttribute(element, "aria-pressed", String(element.classList.contains("selected")));
    for (const element of root.querySelectorAll("#balance, #equalizer-balance")) {
      if (!element.disabled) element.disabled = true;
      setAttribute(element, "tabindex", "-1");
      setAttribute(element, "aria-label", "Balance (unavailable)");
    }
    for (const [id, label] of Object.entries(menus)) {
      const element = root.querySelector(`#${id}`);
      if (!element) continue;
      const open = Boolean(element.querySelector("ul"));
      // The sprite popup replaces the launcher; exposing it as a menu when open
      // avoids putting interactive menu items inside an accessibility button.
      setControl(element, label, open ? "menu" : "button");
      setAttribute(element, "aria-haspopup", open ? null : "menu");
      setAttribute(element, "aria-expanded", String(open));
      for (const item of element.querySelectorAll("li > div")) {
        const key = [...item.classList].find(value => options[value]);
        if (key) setControl(item.querySelector(".handle") || item, options[key], "menuitem");
      }
    }
    for (const element of root.querySelectorAll(".playlist-top-title")) describeReadout(element, "Winamp playlist");
    for (const element of root.querySelectorAll(".playlist-running-time-display")) describeReadout(element, `Selected and total playlist duration: ${element.textContent.trim()}`);
    for (const element of root.querySelectorAll("#playlist-shade-track-title, #playlist-shade-time")) describeReadout(element, `${element.id.endsWith("time") ? "Track duration" : "Playlist track"}: ${element.textContent.trim() || "No track"}`);
    const popup = document.querySelector("#webamp-context-menu .context-menu");
    if (popup && contextOpener?.isConnected && contextOpener.closest(".playlist-menu")?.querySelector("ul")) {
      setAttribute(popup, "role", "menu");
      setAttribute(popup, "aria-label", contextOpener.getAttribute("aria-label"));
      for (const item of popup.querySelectorAll("li:not(.hr):not(.parent)")) setControl(item, item.textContent.trim(), "menuitem");
    }
  }
  const menuItems = menu => [...menu.querySelectorAll('[role="menuitem"]')];
  const afterRender = callback => {
    const expectedFocus = document.activeElement;
    requestAnimationFrame(() => {
      update();
      // A menu command can finish before this frame. Preserve a newer focus
      // choice instead of returning it to the previous menu's launcher.
      const currentFocus = document.activeElement;
      // Webamp's FocusTarget moves focus from body to this generic container
      // when a focused menu item unmounts. That is also a recovery state.
      const windowContainer = root.querySelector("#playlist-window, #playlist-window-shade")?.parentElement;
      const windowFallback = currentFocus?.getAttribute("tabindex") === "-1" && (currentFocus === windowContainer || currentFocus.matches("#main-window > [tabindex], #equalizer-window > [tabindex]"));
      if (currentFocus !== expectedFocus && currentFocus !== document.body && !windowFallback && currentFocus?.isConnected) return;
      callback();
    });
  };
  // Selecting an EQ window remounts its keyed title buttons. Recover the same
  // control after React replaces it, without overriding a newer focus choice.
  root.addEventListener("focusin", event => {
    const control = event.target.closest?.('[data-skin-control="true"][id]');
    if (control) afterRender(() => {
      if (!control.isConnected) root.querySelector(`#${CSS.escape(control.id)}`)?.focus();
    });
  }, true);
  document.addEventListener("click", event => {
    const handle = event.target.closest?.('.handle[data-skin-control="true"]');
    if (handle && root.contains(handle)) contextOpener = handle;
    else if (!event.target.closest?.("#webamp-context-menu")) contextOpener = null;
  }, true);
  document.addEventListener("keydown", event => {
    const control = event.target.closest?.('[data-skin-control="true"]');
    if (!control) return;
    if (control.getAttribute("aria-disabled") === "true") {
      if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    const menu = control.closest('[role="menu"]');
    const launcher = control.closest(".playlist-menu");
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!menu && launcher === control) { control.click(); afterRender(() => menuItems(control)[event.key === "ArrowUp" ? menuItems(control).length - 1 : 0]?.focus()); return; }
      if (!menu) return;
      const items = menuItems(menu), index = items.indexOf(control);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Escape" && menu) {
      event.preventDefault(); event.stopPropagation();
      const owner = launcher || contextOpener?.closest(".playlist-menu");
      owner?.click(); afterRender(() => owner?.focus());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); event.stopPropagation();
      const handle = control.matches(".handle") ? control : control.querySelector(".handle");
      if (handle) contextOpener = control;
      const owner = launcher || contextOpener?.closest(".playlist-menu");
      (handle || control).click();
      afterRender(() => {
        const popup = handle && document.querySelector('#webamp-context-menu [role="menu"]');
        if (popup) menuItems(popup)[0]?.focus();
        else if (launcher?.querySelector("ul")) menuItems(launcher)[0]?.focus();
        else if (owner) owner.focus();
        else if (!control.isConnected && control.id) root.querySelector(`#${CSS.escape(control.id)}`)?.focus();
      });
    }
  });
  update();
  // React replaces sprites/text on skin/shade/menu changes and toggles selected
  // classes. Our own ARIA writes never trigger a mutation feedback loop.
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true, characterData: true, attributes: true, attributeFilter: ["class"], subtree: true });
  observer.observe(document.body, { childList: true });
}
