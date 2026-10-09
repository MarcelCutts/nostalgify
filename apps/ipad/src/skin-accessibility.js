// Webamp's sprite controls are divs. Keep their original handlers and artwork,
// while exposing actual actions and complete readouts to iPad accessibility APIs.
export function installSkinAccessibility(root) {
  const bitmapReadouts = "#marquee, #kbps, #khz, #time, .mini-time";
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
    "#playlist-shade-button": "Toggle compact playlist", "#playlist-close-button": "Close playlist",
    "#playlist-scroll-up-button": "Scroll playlist up", "#playlist-scroll-down-button": "Scroll playlist down",
    ".playlist-previous-button": "Classic player: Previous track", ".playlist-play-button": "Classic player: Play", ".playlist-pause-button": "Classic player: Pause",
    ".playlist-stop-button": "Classic player: Stop", ".playlist-next-button": "Classic player: Next track", ".playlist-eject-button": "Classic player: Open music",
  };
  let contextOpener;
  const setControl = (element, label, role = "button") => {
    element.setAttribute("role", role);
    element.setAttribute("aria-label", label);
    element.tabIndex = role === "menuitem" ? -1 : 0;
    element.dataset.skinControl = "true";
  };
  const describeReadout = (element, label) => {
    element.removeAttribute("aria-hidden");
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", label);
    for (const child of element.children) child.setAttribute("aria-hidden", "true");
  };
  function update() {
    // Avoid exposing individual off-screen glyphs where the shell supplies full
    // current-track/status text and spoken playback time.
    for (const element of root.querySelectorAll(bitmapReadouts)) element.setAttribute("aria-hidden", "true");
    // EQ artwork has no audio effect; preserve its description and window actions.
    for (const element of root.querySelector("#equalizer-window")?.querySelectorAll(decorativeEQ) || []) element.setAttribute("aria-hidden", "true");
    for (const [selector, label] of Object.entries(buttons)) for (const element of root.querySelectorAll(selector)) setControl(element, label);
    for (const [id, label] of Object.entries(menus)) {
      const element = root.querySelector(`#${id}`);
      if (!element) continue;
      const open = Boolean(element.querySelector("ul"));
      // The sprite popup replaces the launcher; exposing it as a menu when open
      // avoids putting interactive menu items inside an accessibility button.
      setControl(element, label, open ? "menu" : "button");
      if (open) element.removeAttribute("aria-haspopup");
      else element.setAttribute("aria-haspopup", "menu");
      element.setAttribute("aria-expanded", String(open));
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
      popup.setAttribute("role", "menu");
      popup.setAttribute("aria-label", contextOpener.getAttribute("aria-label"));
      for (const item of popup.querySelectorAll("li:not(.hr):not(.parent)")) setControl(item, item.textContent.trim(), "menuitem");
    }
  }
  const menuItems = menu => [...menu.querySelectorAll('[role="menuitem"]')];
  const afterRender = callback => requestAnimationFrame(() => { update(); callback(); });
  document.addEventListener("click", event => {
    const handle = event.target.closest?.('.handle[data-skin-control="true"]');
    if (handle && root.contains(handle)) contextOpener = handle;
    else if (!event.target.closest?.("#webamp-context-menu")) contextOpener = null;
  }, true);
  document.addEventListener("keydown", event => {
    const control = event.target.closest?.('[data-skin-control="true"]');
    if (!control) return;
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
      });
    }
  });
  update();
  // React replaces sprites on skin/shade/menu changes. Observe children only;
  // our own ARIA writes must never trigger a mutation feedback loop.
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true, subtree: true });
  observer.observe(document.body, { childList: true });
}
