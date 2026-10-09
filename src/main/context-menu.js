// Only fixed application actions cross the bridge. Labels, roles, skin paths,
// and native menu callbacks are owned by the main process.
function contextMenuTemplate(kind, state, { action, skinMenu, zoomMenu }) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return [];
  const item = (label, name, options = {}) => ({ label, ...options, click: () => action(name) });
  const check = (label, name, checked, enabled = true) => item(label, name, {
    type: "checkbox", checked: checked === true, enabled: enabled === true,
  });
  const separator = { type: "separator" };
  const playback = [
    item("Previous Track", "previous"), item("Play", "play"),
    item("Pause", "pause"), item("Stop", "stop"), item("Next Track", "next"),
    separator,
    check("Shuffle", "toggleShuffle", state.shuffle), check("Repeat", "toggleRepeat", state.repeat),
    separator, item("Open Current Source", "openCurrentSource"),
  ];
  const options = [
    check("Time Remaining", "toggleTimeMode", state.remaining),
    check("Double-size Skin", "toggleDoubleSize", state.doubled),
    { label: "Window Size", submenu: zoomMenu },
  ];
  const remove = [
    item("Remove Selected", "removeSelected", { enabled: state.hasSelection === true }),
    item("Keep Only Selected", "keepOnlySelected", { enabled: state.hasSelection === true }),
    separator, item("Clear Shelf", "clearShelf"),
  ];
  const select = [item("Select All", "selectAll"), item("Select None", "selectNone"), item("Invert Selection", "invertSelection")];
  const sort = [item("Sort Alphabetically", "sortAlphabetically"), item("Reverse Order", "reverseOrder"), item("Randomize Order", "randomizeOrder")];
  switch (kind) {
    case "main": return [
      { role: "about", label: "About Nostalgify" }, separator,
      item("Add Music Link from Clipboard", "addMusicLink"),
      { label: "Playback", submenu: playback }, separator,
      check("Equalizer Panel", "toggleEqualizerPanel", state.equalizerPanelOpen, state.equalizerPanelAvailable),
      check("Shelf", "togglePlaylistWindow", state.playlistOpen),
      { label: "Skins", submenu: skinMenu },
      { label: "Options", submenu: options }, separator,
      { role: "minimize" }, { role: "quit", label: "Quit Nostalgify" },
    ];
    case "options": return [...options, separator, { label: "Skins", submenu: skinMenu }];
    case "add": return [item("Add Music Link from Clipboard", "addMusicLink")];
    case "remove": return remove;
    case "select": return select;
    case "misc": return sort;
    case "list": return [{ label: "Your shelf is saved automatically", enabled: false }, separator, item("Clear Shelf", "clearShelf")];
    default: return [];
  }
}

module.exports = { contextMenuTemplate };
