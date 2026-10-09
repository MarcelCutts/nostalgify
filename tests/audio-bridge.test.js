const test = require("node:test");
const assert = require("node:assert/strict");
const { createAudioBridge } = require("../apps/desktop/src/main/audio-bridge");

function harness(send) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const messages = [];
  const bridge = createAudioBridge({
    send: (message) => { messages.push(message); send?.(message); },
    schedule: (callback, delay) => {
      const timer = ++nextTimer;
      timers.set(timer, { callback, at: now + delay });
      return timer;
    },
    cancel: (timer) => timers.delete(timer),
  });
  return {
    bridge, messages, timers,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
  };
}

test("acknowledgements correlate both request and session, independently of delivery order", async () => {
  const h = harness();
  const settled = [];
  const first = h.bridge.sendAudio({ type: "pause", session: "first" }).then(() => settled.push("first"));
  const second = h.bridge.sendAudio({ type: "pause", session: "second" }).then(() => settled.push("second"));
  for (const result of [null, {}, { requestId: 1 }, { requestId: "unknown", session: "first" },
    { requestId: h.messages[0].requestId, session: "second" }]) h.bridge.onDone(result);
  await Promise.resolve();
  assert.deepEqual(settled, []);
  assert.equal(h.timers.size, 2);
  h.bridge.onDone(h.messages[1]);
  await second;
  assert.deepEqual(settled, ["second"]);
  assert.equal(h.timers.size, 1);
  h.bridge.onDone(h.messages[0]);
  await first;
  assert.deepEqual(settled, ["second", "first"]);
  assert.equal(h.timers.size, 0);
  h.bridge.onDone({ ...h.messages[0], error: "duplicate" });
  assert.deepEqual(settled, ["second", "first"]);
});

test("renderer failures reject with a fixed message and release the acknowledgement timer", async () => {
  const h = harness();
  const pending = h.bridge.sendAudio({ type: "seek", session: "track" });
  const rejected = assert.rejects(pending, { message: "The audio player could not complete that command." });
  h.bridge.onDone({ ...h.messages[0], error: "https://private.example/?token=synthetic" });
  await rejected;
  assert.equal(h.timers.size, 0);
});

test("missing acknowledgements time out and late replies cannot settle a newer request", async () => {
  const h = harness();
  const rejected = assert.rejects(h.bridge.sendAudio({ type: "load", session: "track" }),
    { message: "The audio player did not respond. Reload Nostalgify and try again." });
  h.advance(9999);
  assert.equal(h.timers.size, 1);
  h.advance(1);
  await rejected;
  assert.equal(h.timers.size, 0);
  const next = h.bridge.sendAudio({ type: "load", session: "track" });
  assert.notEqual(h.messages[0].requestId, h.messages[1].requestId);
  h.bridge.onDone(h.messages[0]);
  assert.equal(h.timers.size, 1);
  h.bridge.onDone(h.messages[1]);
  await next;
  assert.equal(h.timers.size, 0);
});

test("renderer reload cancels every pending command and permits fresh requests afterwards", async () => {
  const h = harness();
  const commands = ["pause", "seek"].map((type) => assert.rejects(h.bridge.sendAudio({ type, session: "old" }),
    { message: "The player window reloaded" }));
  h.bridge.cancelAll();
  await Promise.all(commands);
  assert.equal(h.timers.size, 0);
  h.bridge.cancelAll();
  const next = h.bridge.sendAudio({ type: "load", session: "old" });
  for (const message of h.messages.slice(0, 2)) h.bridge.onDone(message);
  assert.equal(h.timers.size, 1);
  h.bridge.onDone(h.messages[2]);
  await next;
  assert.equal(h.timers.size, 0);
});

test("synchronous transport failures reject safely without leaving a pending timeout", async () => {
  const h = harness(() => { throw new Error("private native transport detail"); });
  await assert.rejects(h.bridge.sendAudio({ type: "load", session: "track" }),
    { message: "The audio player could not complete that command." });
  assert.equal(h.timers.size, 0);
  h.bridge.onDone(h.messages[0]);
  h.bridge.cancelAll();
});

test("an immediate acknowledgement is registered before sending the command", async () => {
  let h;
  h = harness((message) => h.bridge.onDone(message));
  await h.bridge.sendAudio({ type: "pause", session: "track" });
  assert.equal(h.timers.size, 0);
});
