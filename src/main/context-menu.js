// Only fixed application actions cross the bridge. Labels, roles, skin paths,
// and native menu callbacks are owned by the main process.
function contextMenuTemplate(kind, state, { action, skins, zoom }) {
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
    check("Shuffle", "shuffle", state.shuffle), check("Repeat", "repeat", state.repeat),
    separator, item("Open Current Source", "source"),
  ];
  const options = [
    check("Time Remaining", "time", state.remaining),
    check("Double-size Skin", "double", state.doubled),
    { label: "Window Size", submenu: zoom },
  ];
  const remove = [
    item("Remove Selected", "remove", { enabled: state.hasSelection === true }),
    item("Keep Only Selected", "crop", { enabled: state.hasSelection === true }),
    separator, item("Clear Shelf", "clear"),
  ];
  const select = [item("Select All", "selectAll"), item("Select None", "selectNone"), item("Invert Selection", "invert")];
  const sort = [item("Sort by Title", "sort"), item("Reverse Order", "reverse"), item("Randomize Order", "randomize")];
  switch (kind) {
    case "main": return [
      { role: "about", label: "About Nostalgify" }, separator,
      item("Add Music Link from Clipboard", "add"),
      { label: "Playback", submenu: playback }, separator,
      check("Equalizer", "equalizer", state.equalizerOpen, state.equalizerAllowed),
      check("Playlist Editor", "playlist", state.playlistOpen),
      { label: "Skins", submenu: skins },
      { label: "Options", submenu: options }, separator,
      { role: "minimize" }, { role: "quit", label: "Quit Nostalgify" },
    ];
    case "options": return [...options, separator, { label: "Skins", submenu: skins }];
    case "add": return [item("Add Music Link from Clipboard", "add")];
    case "remove": return remove;
    case "select": return select;
    case "misc": return sort;
    case "list": return [{ label: "Your shelf is saved automatically", enabled: false }, separator, item("Clear Shelf", "clear")];
    default: return [];
  }
}

module.exports = { contextMenuTemplate };
