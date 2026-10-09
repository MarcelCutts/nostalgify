// Webamp normally owns audio playback through its Media class. This replacement
// relays Webamp's transport and volume to the active provider. SoundCloud's
// actual audio lives in soundcloudAudio; Spotify remains an external player.
import { createDecorativeVisualizer } from "./decorativeVisualizer.js";

export const bridge = {
  media: null,
  quiet: 0, // provider state updates must not echo back as user commands
  onCommandError: null,
};

export async function sendCommand(command, arg) {
  try {
    const result = await window.nostalgify.command(command, arg);
    if (result?.error) bridge.onCommandError?.(result.error);
    return result;
  } catch {
    const error = "Playback command failed. Try again.";
    bridge.onCommandError?.(error);
    return { error };
  }
}

export function quietly(fn) {
  bridge.quiet++;
  try {
    return fn();
  } finally {
    bridge.quiet--;
  }
}

export class PlaybackMedia {
  constructor() {
    this._handlers = {};
    this._elapsed = 0;
    this._duration = 0;
    this._volumeReady = false; // ignore Webamp's default volume until the first state update
    this.lastUserVolumeAt = 0;
    this._visualizer = createDecorativeVisualizer();
    bridge.media = this;
  }

  on(event, cb) {
    (this._handlers[event] ||= []).push(cb);
  }
  emit(event) {
    (this._handlers[event] || []).forEach((cb) => cb());
  }

  // Called by the sync loop.
  setTiming(elapsed, duration) {
    this._elapsed = elapsed;
    this._duration = duration;
    this.emit("timeupdate");
  }
  setVisualizerPlaying(on) {
    this._visualizer.setPlaying(on);
  }
  markVolumeReady() {
    this._volumeReady = true;
  }

  timeElapsed() {
    return this._elapsed;
  }
  duration() {
    return this._duration;
  }
  timeRemaining() {
    return Math.max(0, this._duration - this._elapsed);
  }
  percentComplete() {
    return this._duration ? (this._elapsed / this._duration) * 100 : 0;
  }

  async play() {
    if (!bridge.quiet) await sendCommand("play");
  }
  pause() {
    this._visualizer.setPlaying(false);
    if (!bridge.quiet) void sendCommand("pause");
  }
  stop() {
    // Model Winamp Stop as pause, then seek to the beginning for either provider.
    this._visualizer.setPlaying(false);
    if (!bridge.quiet) {
      void sendCommand("pause").then((result) => {
        if (!result?.error) return sendCommand("seek", 0);
      });
      this.setTiming(0, this._duration);
    }
  }
  seekToPercentComplete(percent) {
    this.seekToTime((percent / 100) * this._duration);
  }
  seekToTime(seconds) {
    this.setTiming(seconds, this._duration);
    if (!bridge.quiet) void sendCommand("seek", seconds);
  }
  setVolume(volume) {
    if (!this._volumeReady || bridge.quiet) return;
    this.lastUserVolumeAt = performance.now();
    void sendCommand("volume", volume);
  }

  // Track changes originate from the provider, so loading just tells Webamp
  // the "file" is ready. Duration was set beforehand by the sync loop.
  async loadFromUrl(url, autoPlay) {
    // Shelf entries identify saved music links; playback is started by the shelf.
    if (String(url).startsWith("shelf:")) return;
    this.emit("fileLoaded");
    if (autoPlay) this.emit("playing");
  }

  // Balance, preamp and EQ stay cosmetic for both providers.
  setBalance() {}
  setPreamp() {}
  setEqBand() {}
  disableEq() {}
  enableEq() {}

  getAnalyser() {
    return this._visualizer.analyser;
  }
  dispose() {}
}
