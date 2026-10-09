// Nostalgify: classic Winamp skins for Spotify desktop control and SoundCloud playback.
// The main process owns provider coordination, SoundCloud credentials and media
// requests, Spotify AppleScript calls, skins, native menus, and the app window.
const { app, BrowserWindow, ipcMain, protocol, Menu, shell, screen, net, clipboard, safeStorage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const STARTER_SKINS = require("./starterSkins");
const { createPlayback } = require("./playback");
const { spotifyCommandError } = require("./spotify-errors");
const { cleanShelf } = require("./shelf");
const { createSoundCloudAuth } = require("./soundcloud/auth");
const { createTokenStore } = require("./soundcloud/token-store");
const { createSoundCloudClient } = require("./soundcloud/client");
const { createMediaProxy } = require("./soundcloud/media-proxy");
const { createElectronSoundCloudFetch } = require("./soundcloud/electron-fetch");

// In development the skins live next to the code. The packaged app uses a
// visible folder in ~/Music so dropping skins in is easy.
const DEV_SKINS_DIR = path.join(__dirname, "..", "..", "skins");
let SKINS_DIR = DEV_SKINS_DIR;
const PREFS_FILE = () => path.join(app.getPath("userData"), "prefs.json");

// Winamp skins are pixel art, so the window scales by whole-page zoom.
// cssSize is the stacked Winamp windows' size at 1x, reported by the page.
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
let zoom = 2;
let cssSize = { w: 275, h: 232 };

let win = null;
let playback = null;
let soundcloudAuth = null;
let soundcloudClient = null;
let soundcloudMedia = null;
let soundcloudConfigError = null;
let audioRequestId = 0;
const audioRequests = new Map();

function sendAudio(message) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.reject(new Error("Player window is closed"));
  const requestId = String(++audioRequestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      audioRequests.delete(requestId);
      reject(new Error("The audio player did not respond. Reload Nostalgify and try again."));
    }, 10000);
    audioRequests.set(requestId, { resolve, reject, timer, session: message.session });
    win.webContents.send("playback:audio-command", { ...message, requestId });
  });
}

function fromPlayer(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
}

function cancelAudioRequests() {
  for (const request of audioRequests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("The player window reloaded"));
  }
  audioRequests.clear();
}

async function connectSoundCloud() {
  try {
    if (soundcloudConfigError) throw new Error(soundcloudConfigError);
    // Environment credentials can read public content without a browser login.
    if (process.env.SOUNDCLOUD_CLIENT_SECRET) await soundcloudAuth.reconnect();
    else await soundcloudAuth.connect();
    await dialog.showMessageBox(win, { type: "info", message: "SoundCloud is connected", detail: "Copy a SoundCloud track or playlist link and paste it into Nostalgify." });
  } catch (error) {
    await dialog.showMessageBox(win, { type: "error", message: "Could not connect to SoundCloud", detail: error.message });
  }
}

async function playbackCommand(cmd, arg) {
  if (!playback) return { error: "Player is starting" };
  return playback.command(cmd, arg);
}

// ---------- log ----------
// Problems talking to Spotify go to ~/Library/Application Support/Nostalgify/nostalgify.log
function logLine(...parts) {
  const line = new Date().toISOString() + " " + parts.join(" ") + "\n";
  console.log(line.trimEnd());
  try {
    const file = path.join(app.getPath("userData"), "nostalgify.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + ".old");
    fs.appendFileSync(file, line);
  } catch {}
}

// ---------- prefs ----------
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE(), "utf8"));
  } catch {
    return {};
  }
}
function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  try {
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error("Could not save prefs", e);
  }
}

// ---------- skins folder ----------
// Skins are served through a custom skin:// scheme so the renderer never needs
// filesystem access. Only plain filenames inside SKINS_DIR are served.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "skin",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: "soundcloud-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function setupSkinsDir() {
  if (app.isPackaged) SKINS_DIR = path.join(app.getPath("music"), "Nostalgify", "Skins");
  fs.mkdirSync(SKINS_DIR, { recursive: true });
}

// Download the starter skins once, on first launch, if the folder is empty.
// The menu can also fetch them again later.
let downloadingStarters = false;
async function downloadStarterSkins({ force = false } = {}) {
  if (downloadingStarters || process.env.NOSTALGIFY_MOCK) return;
  if (!force && (readPrefs().starterSkinsDownloaded || listSkins().length > 0)) return;
  downloadingStarters = true;
  let got = 0;
  for (const skin of STARTER_SKINS) {
    const dest = path.join(SKINS_DIR, skin.file);
    if (fs.existsSync(dest)) continue;
    let saved = false;
    for (const url of skin.sources) {
      try {
        const res = await net.fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        // A .wsz is a zip file, which starts with "PK". Skip anything else.
        if (buf.length > 10 * 1024 * 1024 || buf.toString("latin1", 0, 2) !== "PK") throw new Error("not a skin file");
        fs.writeFileSync(dest + ".part", buf);
        fs.renameSync(dest + ".part", dest);
        saved = true;
        break;
      } catch (e) {
        logLine("could not download", skin.file, "from", new URL(url).host, e.message);
      }
    }
    if (!saved) continue;
    got++;
    logLine("downloaded starter skin", skin.file);
    if (skin.isDefault && !readPrefs().lastSkin) {
      const entry = listSkins().find((s) => s.url.endsWith(encodeURIComponent(skin.file)));
      if (entry) applySkin(entry);
    }
  }
  writePrefs({ starterSkinsDownloaded: true });
  downloadingStarters = false;
  if (got) buildMenu();
}

// Does this .wsz include its own equalizer artwork (EQMAIN.BMP)? Reads the zip's
// central directory directly. Results are cached by file and modified time.
const eqCache = new Map();
function skinHasEq(file) {
  const full = path.join(SKINS_DIR, file);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return false;
  }
  const key = file + ":" + stat.mtimeMs;
  if (eqCache.has(key)) return eqCache.get(key);
  let has = false;
  try {
    const buf = fs.readFileSync(full);
    // Find the end-of-central-directory record, scanning back over any comment.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd >= 0) {
      const count = buf.readUInt16LE(eocd + 10);
      let off = buf.readUInt32LE(eocd + 16);
      for (let n = 0; n < count && off + 46 <= buf.length; n++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) break;
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const name = buf.toString("latin1", off + 46, off + 46 + nameLen);
        if (/(^|\/)eqmain\.bmp$/i.test(name)) {
          has = true;
          break;
        }
        off += 46 + nameLen + extraLen + commentLen;
      }
    }
  } catch (e) {
    console.error("Could not inspect skin", file, e.message);
  }
  eqCache.set(key, has);
  return has;
}

function listSkins() {
  let files = [];
  try {
    files = fs.readdirSync(SKINS_DIR);
  } catch {
    fs.mkdirSync(SKINS_DIR, { recursive: true });
  }
  return files
    .filter((f) => f.toLowerCase().endsWith(".wsz") || f.toLowerCase().endsWith(".zip"))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((f) => ({
      name: f.replace(/\.(wsz|zip)$/i, "").replace(/[_]+/g, " "),
      url: "skin://local/" + encodeURIComponent(f),
      hasEq: skinHasEq(f),
    }));
}

function registerSkinProtocol() {
  protocol.handle("skin", async (request) => {
    const file = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
    if (path.basename(file) !== file) return new Response("bad path", { status: 400 });
    try {
      const buf = await fs.promises.readFile(path.join(SKINS_DIR, file));
      return new Response(buf, {
        headers: { "content-type": "application/zip", "access-control-allow-origin": "*" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function pickStartupSkin(skins) {
  const { lastSkin } = readPrefs();
  const remembered = skins.find((s) => s.url === lastSkin);
  if (remembered) return remembered;
  return skins.find((s) => /green.dimension/i.test(s.name)) || skins[0] || null;
}

function applySkin(skin) {
  if (!win || !skin) return;
  writePrefs({ lastSkin: skin.url });
  win.webContents.send("skin:set", skin.url);
  buildMenu();
}

function randomSkin() {
  const skins = listSkins();
  if (skins.length === 0) return;
  const { lastSkin } = readPrefs();
  const pool = skins.length > 1 ? skins.filter((s) => s.url !== lastSkin) : skins;
  applySkin(pool[Math.floor(Math.random() * pool.length)]);
}

let watchTimer = null;
function watchSkinsFolder() {
  try {
    fs.watch(SKINS_DIR, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        buildMenu();
        if (win) win.webContents.send("skins:changed", listSkins());
      }, 400);
    });
  } catch (e) {
    console.error("Could not watch skins folder", e);
  }
}

// ---------- Spotify via AppleScript ----------
function osa(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 4000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.killed ? "timed out" : stderr || err.message));
      else resolve(stdout.replace(/\n$/, ""));
    });
  });
}

// "is running" checks the process list without launching Spotify and without
// needing System Events.
const STATE_SCRIPT = `
if application "Spotify" is running then
  tell application "Spotify"
    set out to (player state as text) & linefeed & (player position as text) & linefeed & (sound volume as text) & linefeed & (shuffling as text) & linefeed & (repeating as text)
    try
      set t to current track
      set out to out & linefeed & (id of t) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (album of t) & linefeed & ((duration of t) as text) & linefeed & (artwork url of t)
    end try
    return out
  end tell
else
  return "notrunning"
end if`;

const num = (s) => {
  const n = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

// NOSTALGIFY_MOCK=1 fakes a playing track, for testing the UI without Spotify.
const mockStart = Date.now();
function mockState() {
  return {
    running: true,
    state: "playing",
    position: 42 + (Date.now() - mockStart) / 1000,
    volume: 60,
    shuffle: true,
    repeat: false,
    track: { id: "spotify:track:mock", name: "Teardrop", artist: "Massive Attack", album: "Mezzanine", duration: 330, artworkUrl: null },
  };
}

let lastStateError = null;
async function getSpotifyState() {
  if (process.env.NOSTALGIFY_MOCK) return mockState();
  try {
    const out = await osa(STATE_SCRIPT);
    if (out === "notrunning") return { running: false, error: null };
    const [state, pos, vol, shuf, rep, id, name, artist, album, dur, art] = out.split("\n");
    if (lastStateError !== "ok") logLine("connected to Spotify:", state, id ? "with a track loaded" : "with nothing loaded");
    lastStateError = "ok";
    return {
      running: true,
      state, // "playing" | "paused" | "stopped"
      position: num(pos), // seconds
      volume: Math.round(num(vol)), // 0-100
      shuffle: shuf === "true",
      repeat: rep === "true",
      track: id
        ? { id, name, artist, album, duration: num(dur) / 1000, artworkUrl: art || null }
        : null,
    };
  } catch (e) {
    // -1743 means macOS automation permission was denied. A timeout usually
    // means the permission prompt is waiting for an answer.
    const msg = e.message.trim();
    let error = msg;
    if (/-1743|not authori[sz]ed/i.test(msg)) error = "permission";
    else if (/timed? ?out|ETIMEDOUT|SIGTERM|killed/i.test(msg)) error = "waiting";
    if (error !== lastStateError) logLine("reading Spotify failed:", msg);
    lastStateError = error;
    return { running: false, error };
  }
}

const COMMANDS = {
  playpause: "playpause",
  play: "play",
  pause: "pause",
  next: "next track",
  previous: "previous track",
};

function spotifyIsRunning() {
  return new Promise((resolve) => execFile("pgrep", ["-x", "Spotify"], (err) => resolve(!err)));
}

// Spotify ignores "launch in background" and pulls itself to the front, so we
// launch it, then hide it whenever it shows itself during the first seconds.
// This uses AppKit directly, so it needs no extra macOS permission.
const HIDE_SPOTIFY_JXA = `
ObjC.import("AppKit");
function run(argv) {
  const seconds = Number(argv[0] || 8);
  const t0 = Date.now();
  let hides = 0;
  while (Date.now() - t0 < seconds * 1000) {
    // Until Spotify's process exists there is nothing to hide.
    try {
      const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.spotify.client").firstObject;
      if (!a.isNil() && !a.isHidden) {
        a.hide;
        hides++;
      }
    } catch (e) {}
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  return "hid " + hides + " times";
}`;

let launching = null;
async function launchSpotifyHidden() {
  if (process.env.NOSTALGIFY_MOCK) return;
  if (await spotifyIsRunning()) return;
  if (launching) return launching;
  launching = new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", HIDE_SPOTIFY_JXA, "8"], { timeout: 15000 }, (err, out) => {
      if (err) logLine("hiding Spotify failed:", err.message.split("\n").slice(-3).join(" "));
      else logLine("launched Spotify in background,", out.trim());
      launching = null;
      resolve();
    });
  });
  execFile("open", ["-g", "-j", "-a", "Spotify"], (err) => {
    if (err) logLine("could not open Spotify:", err.message);
  });
  // Callers only need Spotify ready to take commands, not the full guard period.
  for (let i = 0; i < 30 && !(await spotifyIsRunning()); i++) await wait(250);
  await wait(1500);
}

// Spotify keeps the logged-in username in its local settings file. Liked Songs
// is playable as spotify:user:<username>:collection.
function spotifyUsername() {
  try {
    const prefs = fs.readFileSync(path.join(app.getPath("appData"), "Spotify", "prefs"), "utf8");
    const m =
      prefs.match(/^autologin\.canonical_username="([^"]+)"/m) ||
      prefs.match(/^autologin\.username="([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Eject is Winamp's "open file" button. Here it shows Spotify so you can pick
// something, then hides Spotify and comes back once the song changes.
let ejectWatch = null;
function stopEjectWatch() {
  if (ejectWatch) clearInterval(ejectWatch);
  ejectWatch = null;
}
function hideSpotify() {
  execFile("osascript", ["-l", "JavaScript", "-e", HIDE_SPOTIFY_JXA, "0.3"], () => {});
}
async function ejectToSpotify() {
  stopEjectWatch();
  const before = await getSpotifyState();
  await spotifyCommand("activate");
  const startId = before.track ? before.track.id : null;
  const wasPlaying = before.state === "playing";
  const t0 = Date.now();
  let checking = false;
  const watch = setInterval(async () => {
    if (ejectWatch !== watch || checking) return;
    if (Date.now() - t0 > 5 * 60 * 1000) return stopEjectWatch();
    checking = true;
    const s = await getSpotifyState();
    checking = false;
    if (ejectWatch !== watch) return;
    const picked = s.track && (s.track.id !== startId || (s.state === "playing" && !wasPlaying));
    if (picked) {
      stopEjectWatch();
      hideSpotify();
      if (win) {
        win.show();
        app.focus({ steal: true });
      }
    }
  }, 1000);
  ejectWatch = watch;
}

// Play a shelf entry: Liked Songs, or a Spotify album, playlist, artist or song.
async function playShelf(uri) {
  logLine("playing shelf entry", uri);
  if (uri === "liked") {
    const user = spotifyUsername();
    if (!user) throw new Error("Could not find your Spotify account. Open Spotify and sign in, then try Liked Songs again.");
    return spotifyCommand("playUri", `spotify:user:${user}:collection`);
  }
  if (!/^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/.test(uri)) return;
  return spotifyCommand("playUri", uri);
}

// Play. If Spotify has nothing loaded, start Liked Songs instead.
// Never brings Spotify to the front.
async function playOrFallback() {
  await launchSpotifyHidden();
  const s = await getSpotifyState();
  if (s.error) throw spotifyCommandError(s.error);
  if (s.track) return spotifyCommand("play");
  const user = spotifyUsername();
  if (!user) throw new Error("Could not find your Spotify account. Open Spotify and sign in, then try Liked Songs again.");
  logLine("nothing loaded, playing Liked Songs");
  await spotifyCommand("playUri", `spotify:user:${user}:collection`);
}

async function spotifyCommand(cmd, arg) {
  // In mock mode commands go through the same routing, and only the final
  // AppleScript call is skipped, so tests catch routing mistakes.
  if (process.env.NOSTALGIFY_MOCK) console.log("mock command:", cmd, arg ?? "");
  let line;
  if (COMMANDS[cmd]) line = COMMANDS[cmd];
  else if (cmd === "seek") line = `set player position to ${Math.max(0, num(arg)).toFixed(2)}`;
  else if (cmd === "volume") {
    // Spotify reads back one less than it's given (84 becomes 83), so ask for one more.
    const v = Math.max(0, Math.min(100, Math.round(num(arg))));
    line = `set sound volume to ${v === 0 ? 0 : Math.min(100, v + 1)}`;
  }
  else if (cmd === "shuffle") line = `set shuffling to ${arg ? "true" : "false"}`;
  else if (cmd === "repeat") line = `set repeating to ${arg ? "true" : "false"}`;
  else if (cmd === "activate") line = "activate";
  else if (cmd === "playUri") {
    if (!/^spotify:[A-Za-z0-9:_-]+$/.test(String(arg))) return;
    line = `play track "${arg}"`;
  } else if (cmd === "playOrFallback") return playOrFallback();
  else if (cmd === "eject") return ejectToSpotify();
  else if (cmd === "playShelf") return playShelf(String(arg));
  else return;
  // Spotify comes to the front whenever it's told to play something specific.
  const pullsSpotifyForward = cmd === "playUri";
  const hadFocus = pullsSpotifyForward && win && win.isFocused();
  if (process.env.NOSTALGIFY_MOCK) return console.log("mock applescript:", line);
  try {
    await osa(`tell application "Spotify" to ${line}`);
  } catch (e) {
    const error = spotifyCommandError(e);
    logLine("Spotify command failed:", cmd, error.message);
    throw error;
  }
  if (pullsSpotifyForward) keepSpotifyHidden(2, hadFocus);
}

// Hide Spotify whenever it shows itself over the next few seconds, and give
// focus back to Nostalgify if it had it.
function keepSpotifyHidden(seconds, refocus) {
  execFile("osascript", ["-l", "JavaScript", "-e", HIDE_SPOTIFY_JXA, String(seconds)], () => {
    if (refocus && win) app.focus({ steal: true });
  });
  if (refocus && win) {
    setTimeout(() => {
      if (win) {
        win.show();
        app.focus({ steal: true });
      }
    }, 300);
  }
}

// ---------- menu ----------
function buildMenu() {
  const skins = listSkins();
  const { lastSkin } = readPrefs();
  const template = [
    {
      label: app.name,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "copy" },
        { role: "paste", label: "Paste Music Link" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Skins",
      submenu: [
        { label: "Random Skin", accelerator: "CmdOrCtrl+R", click: randomSkin },
        { label: "Open Skins Folder", click: () => shell.openPath(SKINS_DIR) },
        { label: "Download Starter Skins", click: () => downloadStarterSkins({ force: true }) },
        {
          label: "Browse More Skins Online",
          click: () => shell.openExternal("https://skins.webamp.org/"),
        },
        { type: "separator" },
        ...(skins.length
          ? skins.map((s) => ({
              label: s.name,
              type: "radio",
              checked: s.url === lastSkin,
              click: () => applySkin(s),
            }))
          : [{ label: "Drop .wsz files into the skins folder", enabled: false }]),
      ],
    },
    {
      label: "Playback",
      submenu: [
        { label: "Play/Pause", click: () => playbackCommand("playpause") },
        { label: "Next Track", click: () => playbackCommand("next") },
        { label: "Previous Track", click: () => playbackCommand("previous") },
        { type: "separator" },
        { label: "Use Spotify", type: "radio", checked: playback?.getProvider() !== "soundcloud", click: () => playbackCommand("selectProvider", "spotify") },
        { label: "Use SoundCloud", type: "radio", checked: playback?.getProvider() === "soundcloud", click: () => playbackCommand("selectProvider", "soundcloud") },
        { label: "Open Current Source", click: () => playbackCommand("activate") },
        { type: "separator" },
        { label: "Connect SoundCloud…", click: connectSoundCloud },
        { label: "Forget Local SoundCloud Sign-in", click: async () => {
          if (playback.getProvider() === "soundcloud") await playbackCommand("selectProvider", "soundcloud");
          await soundcloudAuth.disconnect();
        } },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Actual Size", accelerator: "CmdOrCtrl+1", click: () => setZoom(1) },
        { label: "Double Size", accelerator: "CmdOrCtrl+2", click: () => setZoom(2) },
        { label: "Triple Size", accelerator: "CmdOrCtrl+3", click: () => setZoom(3) },
        { type: "separator" },
        { label: "Bigger", accelerator: "CmdOrCtrl+=", click: () => setZoom(zoom + 0.25) },
        { label: "Smaller", accelerator: "CmdOrCtrl+-", click: () => setZoom(zoom - 0.25) },
      ],
    },
    { role: "windowMenu" },
  ];
  if (!app.isPackaged) {
    template.push({ label: "Debug", submenu: [{ role: "toggleDevTools" }, { role: "reload" }] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- window ----------
function createWindow() {
  zoom = clampZoom(readPrefs().zoom ?? 2);
  win = new BrowserWindow({
    width: Math.ceil(cssSize.w * zoom),
    height: Math.ceil(cssSize.h * zoom),
    useContentSize: true,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: true,
    maximizable: false,
    fullscreenable: false,
    title: "Nostalgify",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  // Coming back to Nostalgify by hand ends any Eject round trip.
  win.on("focus", () => stopEjectWatch());
  win.webContents.on("did-finish-load", () => setZoom(zoom, { save: false }));
  win.webContents.on("did-start-loading", () => {
    cancelAudioRequests();
    // Reload destroys its audio element. Invalidate outstanding loads and state.
    playback?.rendererReset();
  });
  // Block Chromium's own pinch and Cmd+/- zoom so only our zoom applies.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  // Webamp's "about" link and anything else that opens a window goes to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => { cancelAudioRequests(); win = null; });
  // Never navigate away from the player, for example to a dropped link.
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  if (process.env.NOSTALGIFY_SELFTEST) {
    require("./selftest")({
      win,
      app,
      screen,
      setZoom,
      cssSize: () => cssSize,
      zoom: () => zoom,
      readPrefs,
      listSkins,
      applySkin,
      spotifyCommand,
      getSpotifyState,
      playback,
    });
  }
}

// ---------- shelf ----------
// Spotify links come as https://open.spotify.com/album/<id> (sometimes with an
// intl-xx/ part or ?si= tracking) or as spotify:album:<id>.
const LINK_RE =
  /(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|artist)\/([A-Za-z0-9]{10,40}))|(?:spotify:(track|album|playlist|artist):([A-Za-z0-9]{10,40}))/g;

function parseLinks(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text).slice(0, 20000).matchAll(LINK_RE)) {
    const kind = m[1] || m[3];
    const id = m[2] || m[4];
    const uri = `spotify:${kind}:${id}`;
    if (!seen.has(uri)) {
      seen.add(uri);
      out.push({ kind, id, uri });
    }
  }
  return out.slice(0, 50);
}

// Spotify's public oEmbed lookup gives a link's title without any login.
const titleCache = new Map();
async function lookupTitle(kind, id) {
  const key = kind + ":" + id;
  if (titleCache.has(key)) return titleCache.get(key);
  let title = null;
  try {
    const url = "https://open.spotify.com/oembed?url=" + encodeURIComponent(`https://open.spotify.com/${kind}/${id}`);
    const res = await Promise.race([net.fetch(url), wait(6000).then(() => null)]);
    if (res && res.ok) {
      const data = await res.json();
      if (typeof data.title === "string" && data.title.trim()) title = data.title.trim().slice(0, 120);
    }
  } catch (e) {
    logLine("title lookup failed for", key, e.message);
  }
  if (title) titleCache.set(key, title);
  return title;
}

// For albums and songs, the public page's link-preview tags name the artist:
// og:description is "Daft Punk · album · 2001 · 14 songs". This is the same
// preview a chat app shows when you paste a link, fetched once per link you add.
const artistCache = new Map();
async function lookupArtist(kind, id) {
  if (kind !== "album" && kind !== "track") return null;
  const key = kind + ":" + id;
  if (artistCache.has(key)) return artistCache.get(key);
  let artist = null;
  try {
    const res = await Promise.race([
      net.fetch(`https://open.spotify.com/${kind}/${id}`, {
        headers: { "User-Agent": `Nostalgify/${app.getVersion()} (+https://github.com/0xchaosbi/nostalgify)` },
      }),
      wait(8000).then(() => null),
    ]);
    if (res && res.ok) {
      const page = (await res.text()).slice(0, 400000);
      const m = page.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/);
      if (m) {
        const parts = decodeEntities(m[1]).split(" · ");
        if (parts.length >= 2 && parts[0].trim()) artist = parts[0].trim().slice(0, 120);
      }
    }
  } catch (e) {
    logLine("artist lookup failed for", key, e.message);
  }
  if (artist) artistCache.set(key, artist);
  return artist;
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const KIND_FALLBACK = { album: "Spotify album", playlist: "Spotify playlist", artist: "Spotify artist", track: "Spotify song" };
async function resolveSpotifyLinks(text) {
  const links = parseLinks(text);
  return Promise.all(
    links.map(async (l) => {
      const [title, artist] = await Promise.all([lookupTitle(l.kind, l.id), lookupArtist(l.kind, l.id)]);
      return { provider: "spotify", kind: l.kind, uri: l.uri, title: title || KIND_FALLBACK[l.kind], artist: artist || undefined };
    })
  );
}

// ---------- size ----------
// The biggest zoom at which the whole player fits on its screen, leaving room
// for the menu bar and Dock. Whichever edge it reaches first sets the limit.
function maxZoomForScreen() {
  if (!win) return ZOOM_MAX;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  return Math.floor(Math.min(area.width / cssSize.w, area.height / cssSize.h) * 20) / 20;
}

function clampZoom(z) {
  const max = Math.min(ZOOM_MAX, maxZoomForScreen());
  const min = Math.min(ZOOM_MIN, max);
  return Math.min(max, Math.max(min, Math.round(z * 20) / 20));
}

// Nudge the window back so none of it hangs off its screen.
function keepOnScreen() {
  if (!win) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const x = Math.max(area.x, Math.min(b.x, area.x + area.width - b.width));
  const y = Math.max(area.y, Math.min(b.y, area.y + area.height - b.height));
  if (x !== b.x || y !== b.y) win.setPosition(x, y);
}

// Apply zoom and resize the window to fit. The order keeps the page's viewport
// at least as big as the Winamp layout, so Webamp never shuffles its windows.
function setZoom(z, { save = true } = {}) {
  if (!win) return;
  const next = clampZoom(z);
  const w = Math.ceil(cssSize.w * next);
  const h = Math.ceil(cssSize.h * next);
  const [curW, curH] = win.getContentSize();
  const growing = w * h >= curW * curH;
  if (growing) win.setContentSize(w, h);
  win.webContents.setZoomFactor(next);
  if (!growing) win.setContentSize(w, h);
  keepOnScreen();
  zoom = next;
  if (save) writePrefs({ zoom });
}

// Dragging the resize grip: track the cursor and scale proportionally.
let resizeTimer = null;
function startResize(edge) {
  if (!win) return;
  const start = screen.getCursorScreenPoint();
  const [startW, startH] = win.getContentSize();
  stopResize();
  resizeTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const zw = (startW + p.x - start.x) / cssSize.w;
    const zh = (startH + p.y - start.y) / cssSize.h;
    const z = edge === "right" ? zw : edge === "bottom" ? zh : Math.max(zw, zh);
    if (clampZoom(z) !== zoom) setZoom(z, { save: false });
  }, 16);
  // Safety net in case the release is never reported.
  setTimeout(stopResize, 30000);
}
function stopResize() {
  if (resizeTimer) {
    clearInterval(resizeTimer);
    resizeTimer = null;
    writePrefs({ zoom });
  }
}

// ---------- IPC ----------
ipcMain.handle("layout", (_e, w, h) => {
  w = Math.round(Number(w));
  h = Math.round(Number(h));
  if (!(w > 0 && h > 0) || (w === cssSize.w && h === cssSize.h)) return;
  cssSize = { w, h };
  setZoom(zoom, { save: false });
});
ipcMain.handle("resize:start", (_e, edge) => startResize(String(edge)));
ipcMain.handle("resize:end", () => stopResize());
ipcMain.handle("playback:state", (event) => fromPlayer(event) ? playback.getState() : null);
ipcMain.handle("playback:command", (event, cmd, arg) => fromPlayer(event) ? playbackCommand(cmd, arg) : { error: "Invalid player" });
ipcMain.on("playback:audio-state", (event, state) => { if (fromPlayer(event)) playback.audioState(state); });
ipcMain.on("playback:audio-done", (event, result) => {
  if (!fromPlayer(event) || !result || typeof result.requestId !== "string") return;
  const request = audioRequests.get(result.requestId);
  if (!request || request.session !== result.session) return;
  clearTimeout(request.timer);
  audioRequests.delete(result.requestId);
  if (result.error) request.reject(new Error("The audio player could not complete that command."));
  else request.resolve();
});
ipcMain.handle("skins:init", () => {
  const skins = listSkins();
  const start = pickStartupSkin(skins);
  if (start) writePrefs({ lastSkin: start.url });
  buildMenu();
  return { skins, initial: start ? start.url : null };
});
ipcMain.handle("skins:chosen", (_e, url) => {
  // The in-window Options > Skins menu changed the skin; remember it.
  if (typeof url === "string" && url.startsWith("skin://")) {
    writePrefs({ lastSkin: url });
    buildMenu();
  }
});
ipcMain.handle("shelf:load", () => cleanShelf(readPrefs().shelf));
ipcMain.handle("shelf:save", (_e, list) => writePrefs({ shelfVersion: 2, shelf: cleanShelf(list) }));
ipcMain.handle("links:resolve", async (event, text) => {
  if (!fromPlayer(event)) return { error: "Invalid player" };
  try {
    const input = String(text).slice(0, 20000);
    const [spotify, soundcloud] = await Promise.all([resolveSpotifyLinks(input), soundcloudClient.resolveLinks(input)]);
    return [...spotify, ...soundcloud];
  } catch (error) { return { error: error.message }; }
});
ipcMain.handle("clipboard:read", async (event) => fromPlayer(event) ? (await clipboard.readText()).slice(0, 20000) : "");
ipcMain.handle("ui:load", () => {
  const p = readPrefs();
  return { playlistOpen: p.playlistOpen, playlistExtraHeight: p.playlistExtraHeight };
});
ipcMain.handle("ui:save", (_e, ui) => {
  const patch = {};
  if (typeof ui.playlistOpen === "boolean") patch.playlistOpen = ui.playlistOpen;
  if (Number.isInteger(ui.playlistExtraHeight) && ui.playlistExtraHeight >= 0 && ui.playlistExtraHeight < 40)
    patch.playlistExtraHeight = ui.playlistExtraHeight;
  writePrefs(patch);
});
ipcMain.handle("window:close", () => app.quit());
ipcMain.handle("window:minimize", () => win && win.minimize());

app.setName("Nostalgify");
// For tests: keep settings in a throwaway folder instead of the real one.
if (process.env.NOSTALGIFY_USER_DATA) app.setPath("userData", process.env.NOSTALGIFY_USER_DATA);
app.whenReady().then(() => {
  setupSkinsDir();
  let config = {};
  try {
    const value = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "soundcloud.json"), "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) config = value;
    else soundcloudConfigError = "SoundCloud configuration must be a JSON object. Check soundcloud.json in the app settings folder.";
  } catch (error) {
    if (error.code !== "ENOENT") soundcloudConfigError = "SoundCloud configuration could not be read. Check soundcloud.json in the app settings folder.";
  }
  const offlineSoundCloud = !app.isPackaged && process.env.NOSTALGIFY_MOCK === "1" && process.env.NOSTALGIFY_SELFTEST === "soundcloud";
  const fetch = offlineSoundCloud
    ? require("../../tests/helpers/soundcloud-fixture").createFixtureFetch()
    // Node's explicit environment-proxy mode uses its already configured CA
    // trust. Native desktop launches retain Electron's system proxy settings.
    : process.env.NODE_USE_ENV_PROXY === "1"
      ? (url, init) => globalThis.fetch(url, init)
      : createElectronSoundCloudFetch(net);
  const authOptions = {
    clientId: offlineSoundCloud ? "offline-fixture-client" : process.env.SOUNDCLOUD_CLIENT_ID || config.clientId,
    clientSecret: offlineSoundCloud ? "offline-fixture-secret" : process.env.SOUNDCLOUD_CLIENT_SECRET,
    redirectUri: process.env.SOUNDCLOUD_REDIRECT_URI || config.redirectUri || "http://127.0.0.1:47832/callback",
    fetch, openExternal: (url) => shell.openExternal(url),
    store: createTokenStore({ filePath: path.join(app.getPath("userData"), "soundcloud-tokens.enc"), safeStorage }),
  };
  try { soundcloudAuth = createSoundCloudAuth(authOptions); }
  catch {
    soundcloudConfigError = "The SoundCloud callback must be a registered http://127.0.0.1 address with an explicit port. Check your SoundCloud configuration.";
    soundcloudAuth = createSoundCloudAuth({ ...authOptions, redirectUri: "http://127.0.0.1:47832/callback", clientId: undefined, clientSecret: undefined });
  }
  soundcloudClient = createSoundCloudClient({ fetch, auth: soundcloudAuth });
  soundcloudMedia = createMediaProxy({ fetch, getAccessToken: () => soundcloudAuth.getAccessToken() });
  protocol.handle("soundcloud-media", (request) => soundcloudMedia.handle(request));
  playback = createPlayback({
    initialProvider: readPrefs().provider,
    spotify: {
      getState: getSpotifyState, command: spotifyCommand, start: launchSpotifyHidden,
      pause: async () => {
        stopEjectWatch();
        if (!process.env.NOSTALGIFY_MOCK && (process.platform !== "darwin" || !(await spotifyIsRunning()))) return;
        const state = await getSpotifyState();
        if (state.error) throw new Error("Pause Spotify before switching music sources.");
        if (state.running) await spotifyCommand("pause");
      },
    },
    soundcloud: soundcloudClient, audio: { send: sendAudio }, media: soundcloudMedia,
    openExternal: (url) => shell.openExternal(url),
    onProviderChange: (provider) => { writePrefs({ provider }); buildMenu(); },
  });
  if (playback.getProvider() === "spotify") launchSpotifyHidden();
  registerSkinProtocol();
  buildMenu();
  watchSkinsFolder();
  createWindow();
  downloadStarterSkins();
});
app.on("before-quit", () => {
  stopEjectWatch();
  void playback?.dispose();
  void soundcloudAuth?.dispose();
});
app.on("window-all-closed", () => app.quit());
