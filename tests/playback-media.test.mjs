import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  entryPoints: [new URL("../packages/player-ui/src/playbackMedia.js", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { PlaybackMedia, quietly } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("Webamp Stop sends one coordinated command and quiet state updates send none", async (t) => {
  const commands = [];
  const originalWindow = globalThis.window;
  globalThis.window = { nostalgify: { command: async (...args) => { commands.push(args); } } };
  t.after(() => { globalThis.window = originalWindow; });
  // Exercise the Webamp media contract without constructing a decorative audio graph.
  const media = Object.assign(Object.create(PlaybackMedia.prototype), {
    _visualizer: { setPlaying() {} }, _handlers: {}, _elapsed: 24, _duration: 60,
  });
  media.stop();
  await new Promise(setImmediate);
  assert.deepEqual(commands, [["stop", undefined]]);
  assert.equal(media.timeElapsed(), 0);
  assert.equal(media.duration(), 60);
  quietly(() => media.stop());
  assert.equal(commands.length, 1);
});
