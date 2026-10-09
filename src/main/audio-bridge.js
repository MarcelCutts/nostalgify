// Correlate renderer command acknowledgements independently of playback state.
// Reloading the renderer rejects pending commands; IDs never repeat afterwards.
function createAudioBridge({ send, schedule = setTimeout, cancel = clearTimeout, timeoutMs = 10000 }) {
  const pending = new Map();
  let nextId = 0;

  function settle(requestId, error) {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    cancel(request.timer);
    if (error) request.reject(error);
    else request.resolve();
  }

  function sendAudio(message) {
    const requestId = String(++nextId);
    return new Promise((resolve, reject) => {
      const timer = schedule(() => settle(requestId,
        new Error("The audio player did not respond. Reload Nostalgify and try again.")), timeoutMs);
      pending.set(requestId, { resolve, reject, timer, session: message.session });
      try { send({ ...message, requestId }); }
      catch { settle(requestId, new Error("The audio player could not complete that command.")); }
    });
  }

  function onDone(result) {
    if (!result || typeof result.requestId !== "string") return;
    const request = pending.get(result.requestId);
    if (!request || request.session !== result.session) return;
    settle(result.requestId, result.error ? new Error("The audio player could not complete that command.") : null);
  }

  function cancelAll() {
    for (const requestId of pending.keys()) settle(requestId, new Error("The player window reloaded"));
  }

  return { sendAudio, onDone, cancelAll };
}

module.exports = { createAudioBridge };
