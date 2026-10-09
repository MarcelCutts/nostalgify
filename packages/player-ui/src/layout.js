// Keeps the Winamp windows stacked top-left (main, equalizer, playlist) and
// tells the main process how big the stack is, so the macOS window fits it.
// Webamp's own window dragging is replaced by moving the macOS window.

const ORDER = [
  ["main", "#main-window"],
  ["equalizer", "#equalizer-window"],
  ["playlist", "#playlist-window, #playlist-window-shade"],
];

export function manageLayout(webamp, host) {
  const store = webamp.store;
  let scheduled = false;
  let lastW = 0;
  let lastH = 0;

  function relayout() {
    scheduled = false;
    const root = document.getElementById("webamp");
    if (!root) return;
    const positions = {};
    let y = 0;
    let w = 0;
    for (const [key, selector] of ORDER) {
      const el = root.querySelector(selector);
      if (!el) continue;
      // The iPad shell scales the stack; retain intrinsic pixels for stacking.
      const r = host.platform === "ios" ? { width: el.offsetWidth, height: el.offsetHeight } : el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      positions[key] = { x: 0, y };
      y += r.height;
      w = Math.max(w, r.width);
    }
    document.body.classList.toggle("has-playlist", "playlist" in positions);
    const current = store.getState().windows.genWindows;
    const moved = Object.entries(positions).some(([key, p]) => {
      const c = current[key] && current[key].position;
      return !c || c.x !== p.x || c.y !== p.y;
    });
    if (moved) {
      store.dispatch({ type: "UPDATE_WINDOW_POSITIONS", positions, absolute: true });
    }
    if (w > 0 && y > 0 && (Math.round(w) !== lastW || Math.round(y) !== lastH)) {
      lastW = Math.round(w);
      lastH = Math.round(y);
      host.layout(lastW, lastH);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(relayout);
  }

  webamp.__onStateChange(schedule);
  window.addEventListener("resize", schedule);
  schedule();
}

// Invisible handles on the right edge, bottom edge and bottom-right corner.
// Dragging them scales the whole player, like Winamp's double-size mode.
export function addResizeGrips(host) {
  for (const edge of ["right", "bottom", "corner"]) {
    const grip = document.createElement("div");
    grip.className = `resize-grip resize-${edge}`;
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      host.resizeStart(edge);
    });
    const end = () => host.resizeEnd();
    grip.addEventListener("pointerup", end);
    grip.addEventListener("lostpointercapture", end);
    document.body.appendChild(grip);
  }
}
