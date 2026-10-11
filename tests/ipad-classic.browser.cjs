// Browser contract regression: simulated native operations, no real audio or iPad claims.
const { chromium, webkit, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const assert = require("node:assert/strict");

const engine = process.env.IPAD_SMOKE_BROWSER || "chromium";
assert.ok(["chromium", "webkit"].includes(engine));
const browserType = engine === "webkit" ? webkit : chromium;
const root = resolve(__dirname, "..");
mkdirSync(join(root, "artifacts"), { recursive: true });
const outdir = mkdtempSync(join(root, "artifacts/classic-regression-"));
const skin = Buffer.from("UEsDBBQAAAAAAAAAIQAf/pkIVQAAAFUAAAAKAAAAUExFRElULlRYVFtUZXh0XQpOb3JtYWw9I0Q4RUM3RgpDdXJyZW50PSNGRkZGRkYKTm9ybWFsQkc9IzEyMTUxNApTZWxlY3RlZEJHPSMzNDNEMzYKRm9udD1BcmlhbApQSwECFAMUAAAAAAAAACEAH/6ZCFUAAABVAAAACgAAAAAAAAAAAAAAgAEAAAAAUExFRElULlRYVFBLBQYAAAAAAQABADgAAAB9AAAAAAA=", "base64");
const albumURI = "spotify:album:0123456789abcdefghijkl";
const trackURI = "spotify:track:abcdefghijkl0123456789";
execFileSync(process.execPath, ["apps/ipad/scripts/build.mjs", "--dev", "--outdir", outdir], { cwd: root, stdio: "inherit" });

async function settle(page) {
  await page.evaluate(async () => {
    await window.__ipad.host.getPreferences();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
}
async function waitForAsync(page, predicate, argument) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const satisfied = await page.evaluate(predicate, argument);
    if (satisfied === true) return;
    assert.ok(Date.now() < deadline, "Asynchronous browser condition did not become true within 15 seconds");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function playlistURLs(page) {
  return page.evaluate(() => {
    const state = window.__webamp.store.getState();
    return state.playlist.trackOrder.map(id => state.tracks[id].url);
  });
}
async function installSpies(page) {
  await page.evaluate(() => {
    window.__classicCalls = { host: [], native: [], importFiles: 0, importSkin: [], selectSkin: [], removeAudio: [] };
    const { host, plugin } = window.__ipad, calls = window.__classicCalls;
    const command = host.command.bind(host), nativeCommand = plugin.command.bind(plugin);
    host.command = (name, arg) => { calls.host.push({ name, arg }); return command(name, arg); };
    plugin.command = options => { calls.native.push({ name: options.command, arg: options.arg }); return nativeCommand(options); };
    const importFiles = host.importFiles.bind(host), importSkin = host.importSkin.bind(host), selectSkin = host.selectSkin.bind(host), removeAudio = host.removeAudio.bind(host);
    host.importFiles = (...args) => { calls.importFiles++; return importFiles(...args); };
    host.importSkin = file => { calls.importSkin.push({ name: file.name, size: file.size }); return importSkin(file); };
    host.selectSkin = id => { calls.selectSkin.push(id); return selectSkin(id); };
    host.removeAudio = id => { calls.removeAudio.push(id); return removeAudio(id); };
  });
}
async function clearCommands(page) {
  await settle(page);
  await page.evaluate(() => { window.__classicCalls.host.length = 0; window.__classicCalls.native.length = 0; });
}
async function menuItem(page, parent, label) {
  await page.locator("#option-context").click();
  const menu = page.locator("#webamp-context-menu .context-menu");
  await menu.waitFor();
  // Built-in Webamp menus use nested <li> text, with the submenu first in DOM.
  const branch = menu.locator(":scope > li.parent").filter({ has: page.locator(`:scope > ul > li`, { hasText: label }) }).filter({ hasText: parent }).first();
  await branch.hover();
  const item = branch.locator(":scope > ul > li").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
  await item.waitFor({ state: "visible" });
  return item;
}

(async () => {
  const executablePath = engine === "chromium" ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (!existsSync(chromium.executablePath()) && existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined) : undefined;
  const browser = await browserType.launch({ executablePath, headless: true, args: engine === "chromium" ? ["--no-sandbox", "--disable-crashpad-for-testing"] : [] });
  const errors = [];
  const context = await browser.newContext({ ...devices["iPad Pro 11"] });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss());
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    await page.addInitScript(() => {
      // The stock UI demo keeps native audio records in memory. This fixture
      // models the device's durable library so a page reload can test membership
      // independently of whether imported audio bytes still exist.
      Object.defineProperty(window, "nostalgify", { configurable: true, set(host) {
        Object.defineProperty(window, "nostalgify", { configurable: true, writable: true, value: host });
        let records = JSON.parse(localStorage.getItem("classic-test-native-library") || "[]");
        const persist = () => localStorage.setItem("classic-test-native-library", JSON.stringify(records));
        const importFiles = host.importFiles.bind(host), removeAudio = host.removeAudio.bind(host);
        host.listAudio = async () => { window.__classicLibraryReads = (window.__classicLibraryReads || 0) + 1; return structuredClone(records); };
        host.importFiles = async () => {
          const result = await importFiles();
          records.push(...result.items); persist(); return result;
        };
        host.removeAudio = async id => { await removeAudio(id); records = records.filter(item => item.id !== id); persist(); };
      } });
    });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["blob:", "data:"].includes(url.protocol)) return route.continue();
      if (url.hostname !== "nostalgify.test") return route.abort();
      const file = resolve(outdir, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(outdir + "/") || !existsSync(file)) return route.fulfill({ status: 404, body: "Not found" });
      const contentType = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto("https://nostalgify.test/?mock=1");
    await page.waitForFunction(() => Boolean(window.__ipad?.mounted));
    console.log("classic regression: startup and unavailable controls");
    await installSpies(page);

    // Initial unavailable transport must remain inert in the main player,
    // playlist mini controls, and keyboard shortcuts, without bridge errors.
    const unavailable = ["#next", "#previous", "#play", "#pause", "#stop", ".playlist-next-button", ".playlist-previous-button", ".playlist-play-button", ".playlist-pause-button", ".playlist-stop-button"];
    for (const compact of [false, true]) {
      if (compact) await page.getByRole("button", { name: "Toggle compact player", exact: true }).click();
      for (const selector of unavailable) {
        const control = page.locator(`#webamp ${selector}`);
        await page.waitForFunction(selector => document.querySelector(`#webamp ${selector}`)?.getAttribute("aria-disabled") === "true", selector);
        await control.evaluate(element => element.click());
        await control.focus();
        await page.keyboard.press("Enter");
      }
    }
    await page.getByRole("button", { name: "Toggle compact player", exact: true }).click();
    await page.locator("#main-window > [tabindex='-1']").focus();
    for (const key of ["b", "z", "x", "c", "v", "ArrowLeft", "ArrowRight"]) await page.keyboard.press(key);
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.native), [], "unavailable transport sends no native commands");
    assert.equal(await page.locator("#error-message").isVisible(), false, "unavailable transport must not report unsupported-operation errors");

    for (const uri of [albumURI, trackURI]) {
      await page.locator("#spotify-link").fill(uri);
      await page.locator("#link-form button").click();
    }
    await page.waitForFunction(() => document.querySelectorAll("#spotify-shelf .music-play").length === 2);
    const savedSpotify = await page.evaluate(async () => (await window.__ipad.host.getPreferences()).shelf);
    console.log("classic regression: file and playback menus");
    await (await menuItem(page, "Play", "File...")).click();
    await page.waitForFunction(() => window.__classicCalls.importFiles === 1 && document.querySelectorAll("#local-library .music-play").length === 1);
    await settle(page);
    assert.deepEqual(await page.evaluate(async () => (await window.__ipad.host.getPreferences()).shelf), savedSpotify, "Play > File preserves saved Spotify links");
    const localURI = await page.locator("#local-library .music-play").getAttribute("data-uri");
    assert.ok((await playlistURLs(page)).includes(`shelf:${localURI}`), "Play > File imports into both the native library and classic playlist");
    for (const uri of [albumURI, trackURI]) assert.ok((await playlistURLs(page)).includes(`shelf:${uri}`));

    await page.evaluate(async () => { await window.__ipad.host.connectSpotify(); });
    await page.locator("#spotify-shelf .music-play").first().click();
    await page.waitForFunction(() => window.__ipad.host.getCachedState().state === "playing");
    for (const [label, command] of [["Next", "next"], ["Previous", "previous"]]) {
      await clearCommands(page);
      await (await menuItem(page, "Playback", label)).click();
      await page.waitForFunction(name => window.__classicCalls.native.some(call => call.name === name), command);
      await settle(page);
      assert.deepEqual(await page.evaluate(() => window.__classicCalls.native.map(call => call.name)), [command], `Playback > ${label} controls the provider without playing another shelf album`);
    }

    // Spotify volume is unavailable in normal and compact equalizer modes.
    console.log("classic regression: unavailable volume and native sliders");
    await clearCommands(page);
    for (const selector of ["#native-volume", "#webamp #volume input"]) {
      assert.equal(await page.locator(selector).isDisabled(), true, `${selector} is actually disabled`);
      await page.locator(selector).click({ force: true });
    }
    await page.locator("#webamp #marquee").dispatchEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true });
    await page.getByRole("button", { name: "Toggle compact equalizer", exact: true }).focus();
    await settle(page);
    await page.waitForFunction(() => document.getElementById("equalizer-shade") === document.activeElement);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("equalizer-volume")?.disabled === true);
    await page.locator("#equalizer-volume").click({ force: true });
    await page.getByRole("button", { name: "Toggle compact player", exact: true }).click();
    await page.locator("#main-window.shade").waitFor();
    await page.locator("#main-window .mini-time").dispatchEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true });
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.native), [], "unavailable volume controls send no native commands, including after compact rendering");
    assert.equal(await page.locator("#error-message").isVisible(), false);
    await page.getByRole("button", { name: "Toggle compact player", exact: true }).click();
    await page.getByRole("button", { name: "Toggle compact equalizer", exact: true }).focus();
    await settle(page);
    await page.waitForFunction(() => document.getElementById("equalizer-shade") === document.activeElement);
    await page.keyboard.press("Enter");

    await page.locator("#local-source").click();
    await page.locator("#local-library .music-play").click();
    await page.waitForFunction(() => window.__ipad.host.getCachedState().provider === "local");
    await page.evaluate(() => window.__ipad.host.command("seek", 10));
    await clearCommands(page);
    await page.locator("#seek").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__ipad.host.getCachedState().position === 11);
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.native), [{ name: "seek", arg: 11 }], "native seek arrow advances one range step, without an extra classic five-second seek");
    await clearCommands(page);
    const volumeBefore = await page.locator("#native-volume").inputValue();
    await page.locator("#native-volume").focus();
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(value => window.__ipad.host.getCachedState().volume === value, Number(volumeBefore) - 1);
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.native), [{ name: "volume", arg: Number(volumeBefore) - 1 }], "native volume arrows retain normal range semantics");
    await page.waitForFunction(value => window.__webamp.store.getState().media.volume === value, Number(volumeBefore) - 1);
    await clearCommands(page);
    await page.locator("#webamp #marquee").dispatchEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true });
    await page.waitForFunction(value => window.__ipad.host.getCachedState().volume === value, Number(volumeBefore));
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.native), [{ name: "volume", arg: Number(volumeBefore) }], "main-window wheel still adjusts available local volume");

    // Exercise the shared renderer's desktop branch while retaining a local,
    // observable host. Only platform-dependent keyboard/paste policy changes.
    console.log("classic regression: desktop range focus");
    await page.evaluate(() => { window.__ipad.host.platform = "darwin"; });
    await clearCommands(page);
    await page.locator("#webamp #volume input").focus();
    for (const key of ["b", "z", "c", "x", "v"]) await page.keyboard.press(key);
    await page.waitForFunction(() => window.__classicCalls.native.length >= 5);
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.native.map(call => call.name)), ["next", "previous", "playpause", "play", "stop"], "classic desktop letters work after a Webamp range retains focus");
    const pastedURI = "spotify:track:1111111111111111111111";
    const pasteCanceled = await page.locator("#webamp #volume input").evaluate((element, text) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", text);
      return !element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, pastedURI);
    assert.equal(pasteCanceled, true, "desktop paste on a classic range is handled as a shelf action");
    await page.waitForFunction(uri => {
      const state = window.__webamp.store.getState();
      return state.playlist.trackOrder.some(id => state.tracks[id].url === `shelf:${uri}`);
    }, pastedURI);
    await page.evaluate(async uri => { await window.__ipad.mounted.shelf.removeUri(uri); window.__ipad.host.platform = "ios"; }, pastedURI);

    console.log("classic regression: skin menus and persistence");
    const skinItem = await menuItem(page, "Skins", "Load Skin...");
    const chooserPromise = page.waitForEvent("filechooser");
    await skinItem.click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "Classic regression.wsz", mimeType: "application/zip", buffer: skin });
    await waitForAsync(page, async () => /^[0-9a-f]{64}$/.test((await window.__ipad.host.getPreferences()).skinId || ""));
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.importSkin), [{ name: "Classic regression.wsz", size: skin.length }], "classic skin import stores the selected bytes through the host");
    await settle(page);
    const importedSkinID = await page.evaluate(async () => (await window.__ipad.host.getPreferences()).skinId);
    const importedSkinOption = { value: importedSkinID, label: "Classic regression" };
    assert.equal(await page.locator("#skin-select").inputValue(), importedSkinID, "classic skin import immediately selects its committed choice in the shell picker");
    assert.deepEqual(await page.locator("#skin-select option").evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent }))), [{ value: "", label: "Classic Winamp" }, importedSkinOption], "classic skin import immediately adds its saved id and name to the shell picker");
    await (await menuItem(page, "Skins", "<Base Skin>")).click();
    await waitForAsync(page, async () => (await window.__ipad.host.getPreferences()).skinId === null);
    assert.equal(await page.evaluate(() => window.__classicCalls.selectSkin.at(-1)), null, "classic default selection uses the persisted host choice");
    await settle(page);
    assert.equal(await page.locator("#skin-select").inputValue(), "", "classic default selection immediately resets the shell picker");
    assert.deepEqual(await page.locator("#skin-select option").evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent }))), [{ value: "", label: "Classic Winamp" }, importedSkinOption], "switching to the base skin retains the imported skin option before reload");
    await (await menuItem(page, "Skins", "Classic regression")).click();
    await waitForAsync(page, async id => (await window.__ipad.host.getPreferences()).skinId === id, importedSkinID);
    await settle(page);
    assert.equal(await page.evaluate(() => window.__classicCalls.selectSkin.at(-1)), importedSkinID, "the named classic skin menu selects the saved skin through its host");
    assert.equal(await page.locator("#skin-select").inputValue(), importedSkinID, "the named classic skin menu immediately synchronizes the shell picker with its committed choice");
    await (await menuItem(page, "Skins", "<Base Skin>")).click();
    await waitForAsync(page, async () => (await window.__ipad.host.getPreferences()).skinId === null);
    await settle(page);
    assert.equal(await page.locator("#skin-select").inputValue(), "", "returning from a named skin to the base skin synchronizes the picker before reload");

    console.log("classic regression: local playlist membership");
    await page.evaluate(uri => {
      const { store } = window.__webamp, state = store.getState();
      const id = state.playlist.trackOrder.find(id => state.tracks[id].url === `shelf:${uri}`);
      if (id == null) throw new Error("Imported track is absent from the playlist");
      store.dispatch({ type: "REMOVE_TRACKS", ids: [id] });
    }, localURI);
    await waitForAsync(page, async uri => (await window.__ipad.host.getPreferences()).localPlaylistExcluded?.includes(uri), localURI);
    assert.equal((await playlistURLs(page)).includes(`shelf:${localURI}`), false);
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.removeAudio), [], "classic playlist deletion never deletes native audio");
    assert.equal(await page.locator("#local-library .music-play").count(), 1, "Files continues to show the removed playlist member");
    const readsBefore = await page.evaluate(() => window.__classicLibraryReads);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(reads => window.__classicLibraryReads > reads, readsBefore);
    await settle(page);
    assert.equal((await playlistURLs(page)).includes(`shelf:${localURI}`), false, "library refresh does not restore an excluded playlist member");

    await page.reload();
    await page.waitForFunction(() => Boolean(window.__ipad?.mounted));
    await installSpies(page);
    assert.equal((await playlistURLs(page)).includes(`shelf:${localURI}`), false, "playlist removal survives relaunch with a durable native library");
    assert.equal(await page.evaluate(async () => (await window.__ipad.host.getPreferences()).skinId), null, "default classic skin remains selected after reload");
    assert.equal(await page.locator("#skin-select").inputValue(), "");
    assert.equal(await page.locator("#skin-select option").count(), 2, "the skin imported from the classic menu remains stored after reload");
    assert.equal(await page.evaluate(async () => (await window.__ipad.host.listAudio()).length), 1, "playlist removal preserves native library records after reload");
    await page.locator("#local-source").click();
    await page.locator("#local-library").getByRole("button", { name: /^Add .* to playlist$/ }).click();
    await waitForAsync(page, async uri => !(await window.__ipad.host.getPreferences()).localPlaylistExcluded?.includes(uri), localURI);
    assert.ok((await playlistURLs(page)).includes(`shelf:${localURI}`), "the explicit Files action re-adds an excluded playlist member");
    assert.deepEqual(await page.evaluate(async () => (await window.__ipad.host.getPreferences()).shelf), savedSpotify);
    assert.deepEqual(await page.evaluate(() => window.__classicCalls.removeAudio), []);
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("#error-message").isVisible(), false);
    const unsupportedErrors = await page.evaluate(async () => (await window.__ipad.host.getDiagnostics()).web.filter(event => event.event === "failure" && event.code === "unsupported"));
    assert.deepEqual(unsupportedErrors, [], "unavailable controls do not emit unsupported-operation diagnostics");
    console.log("classic regression: imported library survives a rejected shelf save");
    await settle(page);
    const failedImport = await page.evaluate(async () => {
      const { host, plugin } = window.__ipad;
      const before = await host.listAudio(), setPreferences = plugin.setPreferences;
      plugin.setPreferences = async () => {
        plugin.setPreferences = setPreferences;
        throw Object.assign(new Error("fixture shelf preference failure"), { code: "preferences_too_large" });
      };
      let rejection = null;
      try { await host.importFiles(); }
      catch (error) { rejection = { code: error.code, message: error.message }; }
      return {
        rejection,
        before: before.map(item => item.uri),
        after: (await host.listAudio()).map(item => item.uri),
        visible: [...document.querySelectorAll("#local-library .music-play")].map(button => button.dataset.uri),
      };
    });
    const preferencesTooLarge = "There are too many saved settings. Remove some saved links and try again.";
    assert.deepEqual(failedImport.rejection, { code: "preferences_too_large", message: preferencesTooLarge }, "the import promise preserves the specific shelf-save rejection");
    assert.equal(failedImport.after.length, failedImport.before.length + 1, "native import still adds its file when saving playlist preferences fails");
    assert.deepEqual(failedImport.visible, failedImport.after, "Files refreshes immediately to show every imported native record despite the rejected shelf save");
    assert.equal(await page.locator("#error-message").textContent(), preferencesTooLarge, "the specific preference error remains visible after refreshing Files");
    assert.equal(await page.locator("#error-message").isVisible(), true);
    console.log("classic regression: deleted native file stays removed after a rejected shelf save");
    const deletedURI = failedImport.after.find(uri => !failedImport.before.includes(uri));
    assert.ok((await playlistURLs(page)).includes(`shelf:${deletedURI}`), "the deletion fixture starts with a real classic playlist member");
    await page.evaluate(() => {
      const plugin = window.__ipad.plugin, setPreferences = plugin.setPreferences;
      plugin.setPreferences = async () => {
        plugin.setPreferences = setPreferences;
        throw Object.assign(new Error("fixture deletion preference failure"), { code: "preferences_too_large" });
      };
    });
    await page.locator(`#local-library .remove-item[data-uri="${deletedURI}"]`).click();
    await page.waitForFunction(uri => ![...document.querySelectorAll("#local-library .music-play")].some(button => button.dataset.uri === uri), deletedURI);
    await settle(page);
    assert.deepEqual(await page.evaluate(async () => (await window.__ipad.host.listAudio()).map(item => item.uri)), failedImport.before, "the explicit Files deletion removes only its native audio record despite the preference failure");
    assert.equal((await playlistURLs(page)).includes(`shelf:${deletedURI}`), false, "a failed save while refreshing retained files must not leave the deleted file on the classic playlist");
    assert.equal(await page.locator("#error-message").textContent(), preferencesTooLarge, "native deletion preserves the first specific preference error");
    assert.equal(await page.locator("#error-message").isVisible(), true);
    const deletionRefreshReads = await page.evaluate(() => window.__classicLibraryReads);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(reads => window.__classicLibraryReads > reads, deletionRefreshReads);
    await settle(page);
    assert.equal((await playlistURLs(page)).includes(`shelf:${deletedURI}`), false, "subsequent library refresh cannot retain or resurrect the deleted classic row");
    assert.deepEqual(await page.locator("#local-library .music-play").evaluateAll(buttons => buttons.map(button => button.dataset.uri)), failedImport.before, "Files remains synchronized after another library refresh");
    console.log("classic regression: every vanished file is reconciled despite repeated save failures");
    const removedTogether = await page.evaluate(async () => {
      const { host } = window.__ipad;
      await host.importFiles();
      const items = await host.listAudio();
      // Model two native deletions before the shell receives its foreground
      // refresh; direct native calls leave the shell's cached library intact.
      for (const item of items) await host.removeAudio(item.id);
      return items.map(item => item.uri);
    });
    assert.equal(removedTogether.length, 2, "the repeated-failure fixture removes two native files together");
    for (const uri of removedTogether) assert.ok((await playlistURLs(page)).includes(`shelf:${uri}`), "both vanished files initially remain in the cached classic playlist");
    await page.evaluate(() => {
      const plugin = window.__ipad.plugin, setPreferences = plugin.setPreferences;
      window.__classicPreferenceFailures = 0;
      window.__restorePreferenceSaves = () => { plugin.setPreferences = setPreferences; };
      plugin.setPreferences = async () => {
        window.__classicPreferenceFailures++;
        throw Object.assign(new Error("fixture repeated preference failure"), { code: window.__classicPreferenceFailures === 1 ? "preferences_too_large" : "invalid_preferences" });
      };
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => window.__classicPreferenceFailures === 3);
    await page.waitForFunction(() => document.querySelectorAll("#local-library .music-play").length === 0);
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__ipad.host.listAudio()), [], "both native deletions remain committed");
    assert.deepEqual((await playlistURLs(page)).filter(url => url.startsWith("shelf:local:")), [], "every vanished classic row is removed even when each membership save rejects");
    assert.equal(await page.locator("#error-message").textContent(), preferencesTooLarge, "later removal-save errors do not replace the first refresh failure");
    assert.equal(await page.locator("#error-message").isVisible(), true);
    const repeatedFailureReads = await page.evaluate(() => {
      window.__restorePreferenceSaves();
      return window.__classicLibraryReads;
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(reads => window.__classicLibraryReads > reads, repeatedFailureReads);
    await settle(page);
    assert.deepEqual((await playlistURLs(page)).filter(url => url.startsWith("shelf:local:")), [], "a successful subsequent refresh cannot resurrect either vanished file");
    assert.equal(await page.locator("#local-library .music-play").count(), 0);
    console.log("classic regression: asynchronous menu failures");
    await page.evaluate(() => {
      const plugin = window.__ipad.plugin, importAudio = plugin.importAudio;
      plugin.importAudio = async (...args) => {
        plugin.importAudio = importAudio;
        throw Object.assign(new Error("fixture import failure"), { code: "import_failed" });
      };
    });
    await (await menuItem(page, "Play", "File...")).click();
    await page.waitForFunction(() => document.getElementById("error-message").textContent.includes("No files could be imported"));
    await settle(page);
    assert.equal(await page.locator("#error-message").isVisible(), true, "menu import keeps the specific native failure visible");
    await page.evaluate(() => {
      const plugin = window.__ipad.plugin, setPreferences = plugin.setPreferences;
      plugin.setPreferences = async (...args) => {
        plugin.setPreferences = setPreferences;
        throw Object.assign(new Error("fixture preference failure"), { code: "invalid_preferences" });
      };
      window.__webamp.store.dispatch({ type: "TOGGLE_WINDOW", windowId: "playlist" });
    });
    await page.waitForFunction(() => document.getElementById("error-message").textContent.includes("Those settings could not be saved"));
    await settle(page);
    const unhandled = await page.evaluate(async () => (await window.__ipad.host.getDiagnostics()).web.filter(event => event.code === "unhandled_promise"));
    assert.deepEqual(unhandled, [], "rejected menu imports and UI preference saves are handled without unhandled rejections");
    assert.deepEqual(errors, []);
    const report = { pass: true, engine, browser: browser.version(), actualIPad: false, actualAudio: false, outdir, tests: ["built-in Play > File preserves Spotify shelf", "Playback Next/Previous route to provider", "unavailable main and mini transport, keyboard and compact volume", "normal/compact main-window wheel gates with available local-volume positive control", "native range arrow semantics", "desktop classic range letter shortcuts and paste", "classic skin import, default and named selection immediately synchronize the picker", "local playlist exclusion survives refresh/reload and explicit re-add", "successful native import refreshes Files while preserving a rejected shelf-save error", "native deletion removes classic rows despite a preference failure and stays removed after refresh", "specific menu import and UI preference errors without unhandled rejections"] };
    writeFileSync(join(outdir, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await context.tracing.stop();
  } catch (error) {
    const state = await page.evaluate(() => ({ calls: window.__classicCalls, native: window.__ipad?.host.getCachedState(), media: window.__webamp?.store.getState().media })).catch(() => null);
    writeFileSync(join(outdir, "failure-state.json"), JSON.stringify(state, null, 2));
    await page.screenshot({ path: join(outdir, "failure.png"), fullPage: true, timeout: 5000 }).catch(() => {});
    await context.tracing.stop({ path: join(outdir, "trace.zip") }).catch(() => {});
    writeFileSync(join(outdir, "failure.log"), `${error.stack}\n${errors.join("\n")}`);
    throw error;
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
