import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the renderer's actual state-application functions with a small Redux/media
// boundary. This catches stopping/erasing a real track when a command reports an error.
const renderer = fs.readFileSync(new URL("../packages/player-ui/src/renderer.js", import.meta.url), "utf8");
const functions = renderer.slice(renderer.indexOf("  function showMessage("), renderer.indexOf("  let polling = false;"));

function fixture() {
  const actions = [];
  const timing = [];
  const state = { tracks: {}, media: { status: "STOPPED", shuffle: false, repeat: false, volume: 100 }, userInput: {} };
  const media = {
    lastUserVolumeAt: 0,
    setTiming: (...values) => timing.push(values),
    setVisualizerPlaying: (value) => { media.visualizerPlaying = value; },
    markVolumeReady() {},
  };
  const context = vm.createContext({
    bridge: { media }, host: { platform: "ios" }, eq: { setProvider() {} }, updateAttribution() {},
    performance: { now: () => 10_000 }, quietly: (callback) => callback(),
    shownMessage: null, currentTrackId: null, base: {}, flashing: false,
    store: {
      getState: () => state,
      dispatch(action) {
        actions.push(action);
        if (action.type === "ADD_TRACK_FROM_URL") state.tracks[action.id] = { duration: action.duration };
        if (action.type === "SET_MEDIA_DURATION") state.tracks[action.id].duration = action.duration;
        if (action.type === "PLAY_TRACK") state.media.id = action.id;
        if (action.type === "STOP") state.media.status = "STOPPED";
        if (action.type === "PAUSE") state.media.status = "PAUSED";
        if (action.type === "IS_PLAYING") state.media.status = "PLAYING";
        if (action.type === "SET_USER_MESSAGE") state.userInput.userMessage = action.message;
        if (action.type === "UNSET_USER_MESSAGE") delete state.userInput.userMessage;
      },
    },
  });
  vm.runInContext(functions, context);
  return { apply: context.apply, state, media, actions, timing };
}

const track = { id: "spotify:track:one", name: "Still playing", artist: "Artist", duration: 180 };
const playing = { provider: "spotify", state: "playing", position: 30, track, error: null, message: "" };

test("iPad Spotify command errors retain and advance the current track and transport", () => {
  const f = fixture();
  f.apply(playing);
  const id = f.state.media.id;
  f.apply({ ...playing, position: 45, error: "spotify_command_failed", message: "Spotify could not complete that action." });
  assert.equal(f.state.media.id, id);
  assert.equal(f.state.media.status, "PLAYING");
  assert.equal(f.media.visualizerPlaying, true);
  assert.deepEqual(f.timing.at(-1), [45, 180]);
  assert.equal(f.state.userInput.userMessage, "Spotify could not complete that action.");
  assert.equal(f.actions.some((action) => action.type === "STOP"), false);
  f.apply({ ...playing, position: 46 });
  assert.equal(f.state.media.id, id);
  assert.equal(f.state.userInput.userMessage, undefined);
});

test("a first snapshot with valid playing metadata and a transient error still loads the track", () => {
  const f = fixture();
  f.apply({ ...playing, error: "spotify_command_timeout", message: "Spotify did not confirm that action." });
  assert.ok(f.state.media.id);
  assert.equal(f.state.media.status, "PLAYING");
  assert.deepEqual(f.timing.at(-1), [30, 180]);
  assert.equal(f.actions.find((action) => action.type === "SET_MEDIA_TAGS").title, track.name);
});

test("an unavailable Spotify snapshot without a track still stops the classic transport", () => {
  const f = fixture();
  f.apply(playing);
  f.apply({ ...playing, state: "stopped", track: null, error: "spotify_disconnected", message: "Reconnect Spotify." });
  assert.equal(f.state.media.id, null);
  assert.equal(f.state.media.status, "STOPPED");
  assert.equal(f.media.visualizerPlaying, false);
  assert.deepEqual(f.timing.at(-1), [0, 0]);
  assert.equal(f.state.userInput.userMessage, "Reconnect Spotify.");
});


test("losing a track stops transport even when the preceding transient error message is unchanged", () => {
  const f = fixture();
  const failed = { ...playing, error: "spotify_command_failed", message: "Spotify could not complete that action." };
  f.apply(failed);
  const disconnected = { ...failed, state: "stopped", track: null };
  f.apply(disconnected);
  assert.equal(f.state.media.id, null);
  assert.equal(f.state.media.status, "STOPPED");
  assert.equal(f.media.visualizerPlaying, false);
  assert.deepEqual(f.timing.at(-1), [0, 0]);
  assert.equal(f.state.userInput.userMessage, failed.message);
  f.apply(disconnected);
  assert.equal(f.actions.filter((action) => action.type === "STOP").length, 1, "Repeated unavailable snapshots should not repeatedly reset Webamp");
});
