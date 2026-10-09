// Webamp's HTML popups cannot escape our tightly fitted transparent window.
// Native menus also supply platform keyboard navigation and screen-edge layout.
export function installContextMenus({ webamp, shelf, eq, transport }) {
  const store = webamp.store;
  function show(kind) {
    const s = store.getState();
    window.nostalgify.showContextMenu(kind, {
      equalizerOpen: s.windows.genWindows.equalizer.open,
      equalizerAllowed: eq.allowed(),
      playlistOpen: s.windows.genWindows.playlist.open,
      remaining: s.media.timeMode === "REMAINING",
      doubled: s.display.doubled,
      shuffle: s.media.shuffle,
      repeat: s.media.repeat,
      hasSelection: s.playlist.selectedTracks.some((id) => s.playlist.trackOrder.includes(id)),
    });
  }
  window.addEventListener("contextmenu", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("#webamp")) return;
    event.preventDefault();
    event.stopPropagation();
    show("main");
  }, true);
  const buttons = {
    "option-context": "main", "button-o": "options",
    "playlist-add-menu": "add", "playlist-remove-menu": "remove",
    "playlist-selection-menu": "select", "playlist-misc-menu": "misc", "playlist-list-menu": "list",
  };
  const selector = Object.keys(buttons).map((id) => `#${id}`).join(",");
  window.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest(selector);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    show(buttons[button.id]);
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    show("main");
  }, true);

  window.nostalgify.onMenuAction((action) => {
    const s = store.getState();
    const dispatch = (type, fields = {}) => store.dispatch({ type, ...fields });
    const selected = s.playlist.selectedTracks.filter((id) => s.playlist.trackOrder.includes(id));
    const remove = (ids) => {
      dispatch("REMOVE_TRACKS", { ids });
      dispatch("SELECT_ZERO");
    };
    switch (action) {
      case "add": void shelf.handleAddUrl(); break;
      case "play": transport("playOrFallback"); break;
      case "pause": case "previous": case "next": transport(action); break;
      case "stop": webamp.stop(); break;
      case "source": transport("activate"); break;
      case "shuffle": dispatch("TOGGLE_SHUFFLE"); break;
      case "repeat": dispatch("TOGGLE_REPEAT"); break;
      case "equalizer": if (eq.allowed()) dispatch("TOGGLE_WINDOW", { windowId: "equalizer" }); break;
      case "playlist": dispatch("TOGGLE_WINDOW", { windowId: "playlist" }); break;
      case "time": dispatch("TOGGLE_TIME_MODE"); break;
      case "double": dispatch("TOGGLE_DOUBLESIZE_MODE"); break;
      case "remove": remove(selected); break;
      case "crop":
        if (selected.length) remove(s.playlist.trackOrder.filter((id) => !selected.includes(id)));
        break;
      // Shelf edits should not stop the independent provider's current song.
      case "clear": remove(s.playlist.trackOrder); break;
      case "selectAll": dispatch("SELECT_ALL"); break;
      case "selectNone": dispatch("SELECT_ZERO"); break;
      case "invert": dispatch("INVERT_SELECTION"); break;
      case "sort": dispatch("SET_TRACK_ORDER", {
        trackOrder: [...s.playlist.trackOrder].sort((a, b) =>
          String(s.tracks[a]?.title || "").localeCompare(String(s.tracks[b]?.title || ""))),
      }); break;
      case "reverse": dispatch("REVERSE_LIST"); break;
      case "randomize": dispatch("RANDOMIZE_LIST"); break;
    }
  });
}
