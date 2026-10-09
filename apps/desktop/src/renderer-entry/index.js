import { mountPlayer } from "@nostalgify/player-ui";
import { createSoundCloudAudio } from "./soundcloudAudio.js";

// The Electron host must receive provider commands before the asynchronous UI
// starts. Native iPad playback has its own engine and never imports this entry.
const audio = createSoundCloudAudio();
window.addEventListener("beforeunload", () => audio.dispose(), { once: true });
mountPlayer(window.nostalgify).catch(() => {
  audio.dispose();
  document.getElementById("app").textContent = "Nostalgify could not start. Please relaunch the app.";
});
