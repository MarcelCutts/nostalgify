// AppleScript errors can include the command or other local details. Only
// fixed, actionable messages should cross the playback command bridge.
function spotifyCommandError(error) {
  const detail = String(error?.message || error || "");
  if (/^permission$|-1743|not authori[sz]ed/i.test(detail)) {
    return new Error("Allow Nostalgify to control Spotify in System Settings > Privacy & Security > Automation, then try again.");
  }
  if (/^waiting$|timed? ?out|ETIMEDOUT|SIGTERM|killed/i.test(detail)) {
    return new Error("Spotify did not respond. Check for a macOS Automation prompt, then try again.");
  }
  return new Error("Spotify could not complete that command. Try again or reopen Spotify.");
}

module.exports = { spotifyCommandError };
