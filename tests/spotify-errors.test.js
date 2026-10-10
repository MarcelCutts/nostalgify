const test = require("node:test");
const assert = require("node:assert/strict");
const { spotifyCommandError } = require("../apps/desktop/src/main/spotify-errors");
const { createPlayback } = require("../apps/desktop/src/main/playback");

test("Spotify command errors explain permission and timeout failures without echoing raw details", () => {
  for (const detail of ["permission", "Not authorized to send Apple events. (-1743)", "not authorised: private-command-detail"]) {
    const error = spotifyCommandError(new Error(detail));
    assert.match(error.message, /Privacy & Security > Automation/);
    assert.ok(!error.message.includes("private-command-detail"));
    assert.ok(!error.message.includes("-1743"));
  }
  for (const detail of ["waiting", "timed out", "ETIMEDOUT: private-command-detail", "process killed by SIGTERM"]) {
    const error = spotifyCommandError(detail);
    assert.match(error.message, /did not respond.*Automation prompt/);
    assert.ok(!error.message.includes("private-command-detail"));
  }
  const fallback = spotifyCommandError(new Error("private-command-detail"));
  assert.equal(fallback.message, "Spotify could not complete that command. Try again or reopen Spotify.");
});

test("a Spotify command failure reaches the caller and does not poison subsequent controls", async (t) => {
  const commands = [];
  const player = createPlayback({
    spotify: {
      async command(command) {
        commands.push(command);
        if (commands.length === 1) throw spotifyCommandError(new Error("private-command-detail (-1743)"));
      },
    },
    media: { clear() {} },
  });
  t.after(() => player.dispose());
  const failed = await player.command("play");
  assert.match(failed.error, /Automation/);
  assert.ok(!failed.error.includes("private-command-detail"));
  assert.equal(await player.command("pause"), undefined);
  assert.equal(player.getProvider(), "spotify");
  assert.deepEqual(commands, ["play", "pause"]);
});
