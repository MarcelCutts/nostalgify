// Development-only UI fixture. This module does not play audio or connect accounts.
export function createMockPlugin() {
  let sequence = 0;
  let preferences = {};
  const listeners = new Set();
  const items = [];
  const state = {
    provider: "spotify", running: false, state: "stopped", position: 0, volume: 70, shuffle: false, repeat: false, track: null,
    message: "Development demo · no audio or account connection", capabilities: {},
  };
  const snapshot = () => structuredClone({ ...state, sequence });
  const publish = () => { sequence++; for (const callback of listeners) callback(snapshot()); return snapshot(); };
  const capabilities = local => ({ canSeek: true, canSetVolume: local, canSkipNext: true, canSkipPrevious: true, canShuffle: local, canRepeat: local });
  return {
    async addListener(_name, callback) { listeners.add(callback); return { remove: async () => listeners.delete(callback) }; },
    async getState() { return snapshot(); },
    async getPreferences() { return { value: structuredClone(preferences) }; },
    async setPreferences({ value }) { preferences = structuredClone(value); },
    async configureSpotify() {},
    async connectSpotify() { state.running = true; state.message = "Development demo · Spotify connection simulated"; state.capabilities = capabilities(false); publish(); },
    async disconnectSpotify() { state.running = false; state.track = null; state.state = "stopped"; state.message = "Development demo · disconnected"; publish(); },
    async command({ command, arg }) {
      if (command === "provider") { state.provider = arg; state.capabilities = capabilities(arg === "local"); state.track = null; state.state = "stopped"; }
      if (command === "playShelf") {
        state.track = arg.startsWith("local:") ? { ...items.find(item => item.uri === arg), id: arg } : { id: arg, name: "Demo track", artist: "Simulated Spotify", album: "", duration: 180 };
        state.running = true; state.state = "playing"; state.message = "Development demo · no audio";
      }
      if (["play", "playOrFallback"].includes(command)) state.state = "playing";
      if (command === "pause") state.state = "paused";
      if (command === "playpause") state.state = state.state === "playing" ? "paused" : "playing";
      if (command === "seek") state.position = arg;
      if (command === "volume") state.volume = arg;
      if (command === "shuffle" || command === "repeat") state[command] = arg;
      if (command === "next" && state.track) state.track.name = "Next demo track";
      return { state: publish() };
    },
    async listAudio() { return { items: structuredClone(items) }; },
    async importAudio() {
      const id = crypto.randomUUID();
      const item = { id, uri: `local:${id}`, name: "Imported demo recording", artist: "Demo file", album: "", duration: 60 };
      items.push(item); return { items: [item] };
    },
    async removeAudio({ id }) { const index = items.findIndex(item => item.id === id); if (index >= 0) items.splice(index, 1); },
    async getDiagnostics() { return { version: 1, environment: { mode: "development mock" }, events: [] }; },
    async exportDiagnostics() { return { shared: false }; },
  };
}
