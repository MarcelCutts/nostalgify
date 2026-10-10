// Browser integration only: real Webamp parsing, blob URLs and IndexedDB; mocked native preferences.
const { chromium, webkit, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { crc32 } = require("node:zlib");
const assert = require("node:assert/strict");

const engine = process.env.IPAD_SMOKE_BROWSER || process.env.IPAD_SKINS_BROWSER || "chromium";
assert.ok(["chromium", "webkit"].includes(engine), "IPAD_SMOKE_BROWSER (or IPAD_SKINS_BROWSER) must be chromium or webkit");
const browserType = engine === "webkit" ? webkit : chromium;
const root = resolve(__dirname, "..");
const outdir = mkdtempSync(join(tmpdir(), "nostalgify-ipad-skins-"));
// Separate this suite and engine from other browser tests sharing the CI artifact root.
const artifacts = process.env.IPAD_SMOKE_ARTIFACT_DIR ? join(resolve(process.env.IPAD_SMOKE_ARTIFACT_DIR), "skins", engine) : outdir;
mkdirSync(artifacts, { recursive: true });

function skinFixture(name, background) {
  // One deterministic, uncompressed PLEDIT.TXT entry, with valid CRCs for each color variant.
  const bytes = Buffer.from("UEsDBBQAAAAAAAAAIQAf/pkIVQAAAFUAAAAKAAAAUExFRElULlRYVFtUZXh0XQpOb3JtYWw9I0Q4RUM3RgpDdXJyZW50PSNGRkZGRkYKTm9ybWFsQkc9IzEyMTUxNApTZWxlY3RlZEJHPSMzNDNEMzYKRm9udD1BcmlhbApQSwECFAMUAAAAAAAAACEAH/6ZCFUAAABVAAAACgAAAAAAAAAAAAAAgAEAAAAAUExFRElULlRYVFBLBQYAAAAAAQABADgAAAB9AAAAAAA=", "base64");
  assert.match(background, /^#[0-9a-f]{6}$/i);
  bytes.write(background, bytes.indexOf("#121514"), "ascii");
  const dataOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  const checksum = crc32(bytes.subarray(dataOffset, dataOffset + bytes.readUInt32LE(18)));
  bytes.writeUInt32LE(checksum, 14);
  bytes.writeUInt32LE(checksum, bytes.readUInt32LE(bytes.length - 6) + 16);
  return { name, mimeType: "application/zip", buffer: bytes, id: createHash("sha256").update(bytes).digest("hex"), background };
}

async function installOperationProbe(page) {
  await page.evaluate(() => {
    const host = window.__ipad.host;
    window.__skinOperations = { importSkin: [], selectSkin: [] };
    for (const method of Object.keys(window.__skinOperations)) {
      const original = host[method];
      host[method] = async (...args) => {
        try {
          const value = await original.apply(host, args);
          window.__skinOperations[method].push({ ok: true });
          return value;
        } catch (error) {
          window.__skinOperations[method].push({ ok: false, message: error.message });
          throw error;
        }
      };
    }
  });
}

async function runOperation(page, method, perform) {
  const count = await page.evaluate(method => window.__skinOperations[method].length, method);
  await perform();
  await page.waitForFunction(({ method, count }) => window.__skinOperations[method].length > count, { method, count });
  return page.evaluate(({ method, count }) => window.__skinOperations[method][count], { method, count });
}

async function importSkin(page, fixture) {
  // Clearing the input also makes same-byte re-import dispatch a new change event after failure.
  await page.locator("#skin-file").setInputFiles([]);
  return runOperation(page, "importSkin", () => page.locator("#skin-file").setInputFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer }));
}

async function failNextSkinSave(page, { failRefresh = false } = {}) {
  await page.evaluate(failRefresh => {
    const host = window.__ipad.host, save = host.savePreferences;
    window.__failedSkinSave = null;
    window.__skinRefreshFailed = false;
    host.savePreferences = async update => {
      if (!Object.hasOwn(update, "skinId")) return save(update);
      host.savePreferences = save;
      window.__failedSkinSave = {
        skinId: update.skinId,
        background: window.__webamp.store.getState().display.skinPlaylistStyle?.normalbg || "#000000",
      };
      if (failRefresh) {
        const init = host.initSkins;
        host.initSkins = async () => {
          host.initSkins = init;
          window.__skinRefreshFailed = true;
          throw new Error("Injected picker refresh failure");
        };
      }
      throw new Error("Injected skin preference save failure");
    };
  }, failRefresh);
}

async function assertVisibleSkin(page, background) {
  const rgb = `rgb(${[1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16)).join(", ")})`;
  await page.waitForFunction(({ background, rgb }) => {
    const state = window.__webamp.store.getState().display;
    const playlist = document.getElementById("playlist-window");
    return !state.loading && (state.skinPlaylistStyle?.normalbg || "#000000").toLowerCase() === background.toLowerCase()
      && playlist && getComputedStyle(playlist).backgroundColor === rgb;
  }, { background, rgb });
  assert.equal(await page.locator("#main-window").isVisible(), true);
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const host = window.__ipad.host;
    const skins = (await host.initSkins()).skins.map(({ id, name, url }) => ({ id, name, url })).sort((a, b) => a.id.localeCompare(b.id));
    const records = await new Promise((resolve, reject) => {
      const request = indexedDB.open("nostalgify-ipad-skins", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("skins", "readonly"), read = tx.objectStore("skins").getAll();
        tx.oncomplete = () => { db.close(); resolve(read.result.map(({ id, name, bytes }) => ({ id, name, bytes: Array.from(new Uint8Array(bytes)) }))); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    // Bypass the renderer's fetch listener: checking bytes must not choose a skin.
    const blobs = await Promise.all(skins.map(async skin => ({ id: skin.id, bytes: Array.from(new Uint8Array(await (await window.__skinProbe.fetch(skin.url)).arrayBuffer())) })));
    return {
      selected: (await host.getPreferences()).skinId || null,
      persisted: (await window.__ipad.plugin.getPreferences()).value.skinId || null,
      skins,
      records: records.sort((a, b) => a.id.localeCompare(b.id)),
      blobs,
    };
  });
}

(async () => {
  const system = engine === "chromium" ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (!existsSync(chromium.executablePath()) && existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined) : undefined;
  const errors = [];
  let browser, context, page;
  try {
    execFileSync(process.execPath, ["apps/ipad/scripts/build.mjs", "--dev", "--outdir", outdir], { cwd: root, stdio: "inherit" });
    browser = await browserType.launch({ executablePath: system, headless: true, args: engine === "chromium" ? ["--no-sandbox", "--disable-crashpad-for-testing"] : [] });
    context = await browser.newContext({ ...devices["iPad Pro 11"] });
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.dismiss());
    await page.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      window.__skinProbe = { fetch: window.fetch.bind(window), created: [], revoked: [] };
      URL.createObjectURL = blob => {
        const url = create(blob);
        if (blob.type === "application/zip") window.__skinProbe.created.push(url);
        return url;
      };
      URL.revokeObjectURL = url => { window.__skinProbe.revoked.push(url); revoke(url); };
    });
    // Serve the disposable build directly, including on reload; no local server or remote traffic.
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.protocol === "blob:" || url.protocol === "data:") return route.continue();
      if (url.hostname !== "nostalgify-skins.test") return route.abort();
      const file = resolve(outdir, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(outdir + "/") || !existsSync(file)) return route.fulfill({ status: 404, body: "Not found" });
      const contentType = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto("https://nostalgify-skins.test/?mock=1");
    await page.waitForFunction(() => Boolean(window.__ipad?.mounted));
    await installOperationProbe(page);
    await assertVisibleSkin(page, "#000000");

    const original = skinFixture("Original.wsz", "#121514");
    const selected = skinFixture("Selected.wsz", "#402030");
    const rejected = skinFixture("Rejected.wsz", "#123456");
    for (const skin of [original, selected]) {
      assert.deepEqual(await importSkin(page, skin), { ok: true });
      await assertVisibleSkin(page, skin.background);
      await page.waitForFunction(id => document.getElementById("skin-select").value === id, skin.id);
    }
    const before = await snapshot(page);
    assert.equal(before.selected, selected.id);
    assert.equal(before.persisted, selected.id);
    assert.equal(before.skins.length, 2);
    for (const skin of [original, selected]) {
      assert.deepEqual(before.records.find(record => record.id === skin.id).bytes, [...skin.buffer]);
      assert.deepEqual(before.blobs.find(blob => blob.id === skin.id).bytes, [...skin.buffer]);
    }

    // The re-import differs from the current selection, so restoring visible state is observable.
    await failNextSkinSave(page);
    assert.deepEqual(await importSkin(page, original), { ok: false, message: "Injected skin preference save failure" });
    assert.deepEqual(await page.evaluate(() => window.__failedSkinSave), { skinId: original.id, background: original.background });
    await assertVisibleSkin(page, selected.background);
    assert.deepEqual(await snapshot(page), before, "re-import failure preserves both records, their original blob URLs and bytes, and the prior saved selection");
    assert.equal(await page.locator("#skin-select").inputValue(), selected.id, "failed re-import retains the prior picker selection");

    const createdBefore = await page.evaluate(() => window.__skinProbe.created.length);
    await failNextSkinSave(page);
    assert.deepEqual(await importSkin(page, rejected), { ok: false, message: "Injected skin preference save failure" });
    assert.deepEqual(await page.evaluate(() => window.__failedSkinSave), { skinId: rejected.id, background: rejected.background });
    await assertVisibleSkin(page, selected.background);
    assert.deepEqual(await snapshot(page), before, "failed new import removes only its own record and restores the prior visible and saved skin");
    assert.equal(await page.locator("#skin-select").inputValue(), selected.id, "failed new import retains the prior picker selection");
    const removed = await page.evaluate(count => ({ created: window.__skinProbe.created.slice(count), revoked: window.__skinProbe.revoked }), createdBefore);
    assert.equal(removed.created.length, 1);
    assert.ok(removed.revoked.includes(removed.created[0]), "failed new import releases its new blob URL");
    assert.ok(before.skins.every(skin => !removed.revoked.includes(skin.url)), "existing skin URLs are never revoked by rollback");

    await failNextSkinSave(page);
    assert.deepEqual(await runOperation(page, "selectSkin", () => page.locator("#skin-select").selectOption("")), { ok: false, message: "Injected skin preference save failure" });
    assert.deepEqual(await page.evaluate(() => window.__failedSkinSave), { skinId: null, background: "#000000" });
    await assertVisibleSkin(page, selected.background);
    assert.deepEqual(await snapshot(page), before, "failed default selection restores the prior visible and saved skin");
    assert.equal(await page.locator("#skin-select").inputValue(), selected.id, "failed default selection restores the saved picker selection");

    await failNextSkinSave(page);
    assert.deepEqual(await runOperation(page, "selectSkin", () => page.locator("#skin-select").selectOption(original.id)), { ok: false, message: "Injected skin preference save failure" });
    assert.deepEqual(await page.evaluate(() => window.__failedSkinSave), { skinId: original.id, background: original.background });
    await assertVisibleSkin(page, selected.background);
    assert.deepEqual(await snapshot(page), before, "failed saved-skin selection restores the prior visible and saved skin");
    assert.equal(await page.locator("#skin-select").inputValue(), selected.id, "failed saved-skin selection restores the saved picker selection");

    const malformed = { name: "Malformed.wsz", mimeType: "application/zip", buffer: Buffer.from([80, 75, 3, 4, 0, 0]) };
    const failedParse = await importSkin(page, malformed);
    assert.equal(failedParse.ok, false);
    assert.match(failedParse.message, /skin could not be read/);
    await assertVisibleSkin(page, selected.background);
    assert.deepEqual(await snapshot(page), before, "malformed archive recovery retains the saved skins and selection");

    await failNextSkinSave(page, { failRefresh: true });
    assert.deepEqual(await runOperation(page, "selectSkin", () => page.locator("#skin-select").selectOption("")), { ok: false, message: "Injected skin preference save failure" });
    await page.waitForFunction(() => window.__skinRefreshFailed && !document.getElementById("error-message").hidden);
    assert.equal(await page.locator("#error-message").textContent(), "Injected skin preference save failure", "a secondary picker refresh failure must not replace the original save error");
    await assertVisibleSkin(page, selected.background);
    assert.deepEqual(await snapshot(page), before, "picker refresh failure cannot change the restored visible or saved skin");

    assert.deepEqual(await runOperation(page, "selectSkin", () => page.locator("#skin-select").selectOption(original.id)), { ok: true });
    await assertVisibleSkin(page, original.background);
    assert.equal((await snapshot(page)).persisted, original.id);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__ipad?.mounted));
    await installOperationProbe(page);
    await assertVisibleSkin(page, original.background);
    assert.equal(await page.locator("#skin-select").inputValue(), original.id);
    assert.equal(await page.locator("#skin-select option").count(), 3);
    const reloaded = await snapshot(page);
    assert.equal(reloaded.selected, original.id);
    assert.equal(reloaded.persisted, original.id);
    assert.deepEqual(reloaded.records, before.records, "reload restores the original stored bytes");
    assert.deepEqual(reloaded.blobs, before.blobs, "reload creates usable blob URLs for both stored skins");

    assert.deepEqual(await runOperation(page, "selectSkin", () => page.locator("#skin-select").selectOption("")), { ok: true });
    await assertVisibleSkin(page, "#000000");
    assert.equal((await snapshot(page)).persisted, null);
    assert.deepEqual(errors, [], "rollback and reload produce no uncaught browser exceptions");
    const result = { pass: true, engine, browser: browser.version(), actualIPad: false, actualAudio: false, outdir, artifacts, tests: ["two valid skin imports", "same-byte re-import preference failure preserves records and original URLs", "new import preference failure restores prior visible skin and removes only its new record", "default and saved-skin preference failures restore prior visible skin and picker", "malformed archive recovery", "original save error survives secondary picker refresh failure", "successful selection and IndexedDB reload", "successful default selection"] };
    writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true, timeout: 5000 }).catch(() => {});
    writeFileSync(join(artifacts, "failure.log"), `${error.stack}\n${errors.join("\n")}\n`);
    console.error(`Skin browser artifacts: ${artifacts}`);
    throw error;
  } finally {
    await context?.close();
    await browser?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
