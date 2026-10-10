// Deterministic browser/bridge fixtures only; no physical iPad or audio claims.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit, devices } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = mkdtempSync(join(tmpdir(), "nostalgify-preferences-startup-"));
const engine = process.env.IPAD_SMOKE_BROWSER || "chromium";
assert.ok(["chromium", "webkit"].includes(engine));
const artifacts = resolve(process.env.IPAD_SMOKE_ARTIFACT_DIR || join(output, "artifacts"));
mkdirSync(artifacts, { recursive: true });
// Reusing an artifact directory must not leave reports from a previous run.
for (const file of ["result.json", "failure.json", "failure.png", "trace.zip"]) {
  rmSync(join(artifacts, file), { force: true });
}
const savedLink = { provider: "spotify", kind: "track", uri: "spotify:track:0123456789abcdefghijkl", title: "Previously saved track" };
const newLink = "https://open.spotify.com/album/abcdefghijkl0123456789";
const newerLink = "https://open.spotify.com/playlist/0123456789abcdefghijkl";
const newUri = "spotify:album:abcdefghijkl0123456789";
const newerUri = "spotify:playlist:0123456789abcdefghijkl";
const preferencesKey = "nostalgify-development-preferences";
const results = [];
function recordFailure(error, details) {
  const report = {
    pass: false, engine, output, artifacts, scenariosPassed: [...results],
    actualIPad: false, actualAudio: false, ...details,
    error: { name: error.name, message: error.message, stack: error.stack },
  };
  try { writeFileSync(join(artifacts, "failure.json"), JSON.stringify(report, null, 2) + "\n"); }
  catch (captureError) { console.error("Could not retain failure metadata:", captureError); }
}

execFileSync(process.execPath, ["apps/ipad/scripts/build.mjs", "--dev", "--outdir", output], { cwd: root, stdio: "inherit" });
// Inject failures at the mock plugin boundary in this disposable build. The
// shipped app has no test query parameter or startup failure hook.
await build({
  absWorkingDir: root,
  entryPoints: ["apps/ipad/src/main.js"], outfile: join(output, "app.js"),
  bundle: true, platform: "browser", format: "iife", target: ["safari17"],
  define: { __IPAD_DEVELOPMENT__: "true" },
  plugins: [{ name: "startup-fixture", setup(builder) {
    builder.onLoad({ filter: /apps\/ipad\/src\/mock\.js$/ }, args => ({
      contents: readFileSync(args.path, "utf8").replace("export function createMockPlugin()", "function createFixturePlugin()") + `
        export function createMockPlugin() {
          const plugin = createFixturePlugin();
          const fixture = window.__preferenceTest = {
            readCount: 0, listCount: 0, writeCount: 0,
            ...window.__startupFixtureOptions,
          };
          const read = plugin.getPreferences;
          plugin.getPreferences = async (...args) => {
            fixture.readCount++;
            if (fixture.holdRead) {
              fixture.holdRead = false;
              await new Promise(resolve => { fixture.releaseRead = resolve; fixture.readPending = true; });
              fixture.readPending = false;
            }
            if (fixture.failReads > 0) { fixture.failReads--; throw new Error("Injected preference read failure"); }
            return read(...args);
          };
          const list = plugin.listAudio;
          plugin.listAudio = async (...args) => {
            fixture.listCount++;
            if (fixture.holdList) {
              fixture.holdList = false;
              await new Promise(resolve => { fixture.releaseList = resolve; fixture.listPending = true; });
              fixture.listPending = false;
            }
            if (fixture.failLists > 0) { fixture.failLists--; throw new Error("Injected library read failure"); }
            return list(...args);
          };
          const write = plugin.setPreferences;
          plugin.setPreferences = async (...args) => {
            fixture.writeCount++;
            if (fixture.holdSave) {
              fixture.holdSave = false;
              await new Promise(resolve => { fixture.releaseSave = resolve; fixture.savePending = true; });
              fixture.savePending = false;
            }
            if (fixture.failSaves > 0) { fixture.failSaves--; throw new Error("Injected preference write failure"); }
            return write(...args);
          };
          return plugin;
        }
      `,
      loader: "js", resolveDir: dirname(args.path),
    }));
    builder.onLoad({ filter: /packages\/player-ui\/src\/renderer\.js$/ }, args => ({
      contents: readFileSync(args.path, "utf8").replace("export async function mountPlayer(", "async function mountFixturePlayer(") + `
        export async function mountPlayer(...args) {
          const fixture = window.__preferenceTest;
          fixture.mountCount = (fixture.mountCount || 0) + 1;
          const mounted = await mountFixturePlayer(...args);
          if (fixture.failMount) throw new Error("Injected failure after mount installed its listeners");
          return mounted;
        }
      `,
      loader: "js", resolveDir: dirname(args.path),
    }));
  } }],
});

const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  ...(engine === "chromium" ? { args: ["--no-sandbox", "--disable-crashpad-for-testing"] } : {}),
}).catch(error => { recordFailure(error, { phase: "browser launch" }); throw error; });
async function scenario(name, options, check) {
  let context, page, failed = false;
  const errors = [];
  try {
    context = await browser.newContext({ ...devices["iPad Pro 11"] });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.addInitScript(({ options, savedLink, preferencesKey }) => {
      if (location.hostname !== "nostalgify-startup.test") return;
      if (!sessionStorage.getItem("startup-fixture-seeded")) {
        localStorage.setItem(preferencesKey, JSON.stringify({ shelf: [savedLink], retained: "existing preferences" }));
        window.__startupFixtureOptions = options;
        sessionStorage.setItem("startup-fixture-seeded", "true");
      }
    }, { options, savedLink, preferencesKey });
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["blob:", "data:"].includes(url.protocol)) return route.continue();
      if (url.hostname !== "nostalgify-startup.test") return route.abort();
      const file = resolve(output, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(output + "/") || !existsSync(file)) return route.fulfill({ status: 404, body: "Not found" });
      const contentType = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
      await route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto("https://nostalgify-startup.test/?mock=1");
    await check(page);
    assert.deepEqual(errors, [], "handled storage/startup failures must not become uncaught browser errors");
    await context.tracing.stop();
    results.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    const captures = {}, captureErrors = [];
    if (page) {
      try {
        await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true, timeout: 5000 });
        captures.screenshot = "failure.png";
      } catch (captureError) { captureErrors.push(`Screenshot: ${captureError.message}`); }
    }
    if (context) {
      try {
        await context.tracing.stop({ path: join(artifacts, "trace.zip") });
        captures.trace = "trace.zip";
      } catch (captureError) { captureErrors.push(`Trace: ${captureError.message}`); }
    }
    recordFailure(error, { phase: "scenario", scenario: name, browser: browser.version(), pageErrors: errors, captures, captureErrors });
    throw error;
  } finally {
    try { await context?.close(); }
    catch (error) { if (!failed) throw error; console.error("Could not close failed browser context:", error); }
  }
}
const ready = page => page.waitForFunction(() => Boolean(window.__ipad?.mounted));
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), preferencesKey);
async function expectShelf(page, uris) {
  const preferences = await stored(page);
  assert.deepEqual(preferences.shelf.map(item => item.uri), uris);
  assert.equal(preferences.retained, "existing preferences");
}
try {
  await scenario("early input survives a failed first preference read, save, Files import and reload", { holdRead: true, failReads: 1 }, async page => {
    await page.waitForFunction(() => window.__preferenceTest?.readPending);
    await page.locator("#spotify-link").fill(newLink);
    assert.equal(await page.locator("#save-link").isDisabled(), true);
    // Even a synthetic submit (or an input path bypassing the disabled button)
    // cannot clear the text before the player exists.
    await page.locator("#link-form").dispatchEvent("submit");
    assert.equal(await page.locator("#spotify-link").inputValue(), newLink);
    await expectShelf(page, [savedLink.uri]);
    await page.evaluate(() => window.__preferenceTest.releaseRead());
    await ready(page);
    assert.equal(await page.evaluate(() => window.__preferenceTest.readCount), 2);
    assert.equal(await page.locator("#spotify-link").getAttribute("aria-describedby"), null, "ready input must not retain the hidden startup instructions as its accessible description");
    assert.equal(await page.locator("#spotify-link").inputValue(), newLink);
    assert.equal(await page.locator("#spotify-shelf .music-row").count(), 1);
    await page.locator("#save-link").click();
    await page.waitForFunction(() => document.getElementById("spotify-link").value === "");
    await expectShelf(page, [savedLink.uri, newUri]);
    await page.locator("#local-source").click();
    await page.locator("#import-button").click();
    await page.waitForFunction(() => !document.getElementById("import-button").hasAttribute("aria-busy"));
    await expectShelf(page, [savedLink.uri, newUri]);
    await page.reload();
    await ready(page);
    assert.equal(await page.locator("#spotify-shelf .music-row").count(), 2);
    await expectShelf(page, [savedLink.uri, newUri]);
  });

  await scenario("unavailable preferences keep startup blocked until a single manual retry recovers", { failReads: 2 }, async page => {
    await page.locator("#retry-startup").waitFor({ state: "visible" });
    await page.locator("#spotify-link").fill(newLink);
    assert.equal(await page.locator("#save-link").isDisabled(), true);
    assert.equal(await page.locator("#local-source").isDisabled(), true);
    const message = await page.locator("#startup-message").textContent();
    await page.evaluate(async () => { await window.nostalgify.getState(); window.__preferenceTest.holdList = true; });
    assert.equal(await page.locator("#startup-message").textContent(), message, "state refresh cannot erase startup recovery instructions");
    await page.locator("#retry-startup").click();
    await page.waitForFunction(() => window.__preferenceTest.listPending);
    await page.locator("#retry-startup").dispatchEvent("click");
    assert.equal(await page.evaluate(() => window.__preferenceTest.listCount), 1, "concurrent retries share one startup attempt");
    assert.equal(await page.locator("#save-link").isDisabled(), true);
    await page.evaluate(() => window.__preferenceTest.releaseList());
    await ready(page);
    assert.equal(await page.locator("#spotify-link").inputValue(), newLink);
    assert.equal(await page.locator("#retry-startup").isHidden(), true);
    assert.equal(await page.locator("#local-source").isEnabled(), true);
    assert.equal(await page.locator("#webamp").count(), 1);
    await expectShelf(page, [savedLink.uri]);
  });

  await scenario("an injected initial library failure exposes retry and restores source navigation", { failLists: 1 }, async page => {
    await page.locator("#retry-startup").waitFor({ state: "visible" });
    await page.locator("#spotify-link").fill(newLink);
    await page.locator("#retry-startup").click();
    await ready(page);
    assert.equal(await page.evaluate(() => window.__preferenceTest.listCount), 2);
    assert.equal(await page.locator("#spotify-link").inputValue(), newLink);
    await page.locator("#local-source").click();
    assert.equal(await page.locator("#import-button").isVisible(), true);
    await expectShelf(page, [savedLink.uri]);
  });

  await scenario("a mount-stage rejection does not offer an unsafe second mount", { failMount: true }, async page => {
    await page.waitForFunction(() => document.getElementById("startup-message").textContent.includes("Reopen the app"));
    assert.equal(await page.locator("#retry-startup").isHidden(), true);
    assert.equal(await page.locator("#save-link").isDisabled(), true);
    await page.locator("#spotify-link").fill(newLink);
    await page.locator("#link-form").dispatchEvent("submit");
    const message = await page.locator("#startup-message").textContent();
    await page.locator("#retry-startup").dispatchEvent("click");
    await page.evaluate(() => window.nostalgify.getState());
    assert.equal(await page.locator("#startup-message").textContent(), message);
    assert.equal(await page.evaluate(() => window.__preferenceTest.mountCount), 1);
    assert.equal(await page.locator("#webamp").count(), 1);
    assert.equal(await page.locator("#spotify-link").inputValue(), newLink);
    await expectShelf(page, [savedLink.uri]);
  });

  await scenario("a rejected link save preserves input, reports recovery, and persists on duplicate retry", {}, async page => {
    await ready(page);
    await page.evaluate(() => { window.__preferenceTest.failSaves = 1; });
    await page.locator("#spotify-link").fill(newLink);
    await page.locator("#save-link").click();
    await page.waitForFunction(() => !document.getElementById("save-link").hasAttribute("aria-busy"));
    assert.equal(await page.locator("#spotify-link").inputValue(), newLink);
    assert.equal(await page.locator("#error-message").isVisible(), true);
    assert.match(await page.locator("#error-message").textContent(), /try Save again/);
    await expectShelf(page, [savedLink.uri]);
    await page.locator("#save-link").click();
    await page.waitForFunction(() => document.getElementById("spotify-link").value === "");
    assert.equal(await page.locator("#error-message").isHidden(), true);
    assert.equal(await page.locator("#spotify-shelf .music-row").count(), 2);
    await expectShelf(page, [savedLink.uri, newUri]);
    await page.reload();
    await ready(page);
    assert.equal(await page.locator("#spotify-shelf .music-row").count(), 2);
  });

  await scenario("an acknowledged pending save preserves newer input and ignores duplicate submissions", {}, async page => {
    await ready(page);
    const writesBefore = await page.evaluate(() => { window.__preferenceTest.holdSave = true; return window.__preferenceTest.writeCount; });
    await page.locator("#spotify-link").fill(newLink);
    await page.locator("#save-link").click();
    await page.waitForFunction(() => window.__preferenceTest.savePending);
    await page.locator("#spotify-link").fill(newerLink);
    await page.locator("#link-form").dispatchEvent("submit");
    assert.equal(await page.evaluate(() => window.__preferenceTest.writeCount), writesBefore + 1);
    await page.evaluate(() => window.__preferenceTest.releaseSave());
    await page.waitForFunction(() => !document.getElementById("save-link").hasAttribute("aria-busy"));
    assert.equal(await page.locator("#spotify-link").inputValue(), newerLink);
    await expectShelf(page, [savedLink.uri, newUri]);
    await page.locator("#save-link").click();
    await page.waitForFunction(() => document.getElementById("spotify-link").value === "");
    await expectShelf(page, [savedLink.uri, newUri, newerUri]);
  });
  const report = { pass: true, engine, browser: browser.version(), output, artifacts, scenarios: results, actualIPad: false, actualAudio: false };
  writeFileSync(join(artifacts, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close().catch(error => console.error("Could not close browser:", error)); }
