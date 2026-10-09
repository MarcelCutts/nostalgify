// UI contract smoke only: mocked native plugin, Chromium touch emulation, no real audio/iPad claims.
const { chromium, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const root = resolve(__dirname, "..");
const outdir = mkdtempSync(join(tmpdir(), "nostalgify-ipad-smoke-"));
const artifacts = process.env.IPAD_SMOKE_ARTIFACT_DIR || outdir;
mkdirSync(artifacts, { recursive: true });
execFileSync(process.execPath, ["apps/ipad/scripts/build.mjs", "--dev", "--outdir", outdir], { cwd: root, stdio: "inherit" });
(async () => {
  const system = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({ executablePath: system, headless: true, args: ["--no-sandbox", "--disable-crashpad-for-testing"] });
  const errors = [];
  let page;
  try {
    const context = await browser.newContext({ ...devices["iPad Pro 11"] });
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    // Fulfil requests from the build directory: no server or external traffic.
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== "nostalgify.test") return route.abort();
      const file = resolve(outdir, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(outdir + "/") || !existsSync(file)) return route.fulfill({ status: 404, body: "Not found" });
      const contentType = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto("https://nostalgify.test/?mock=1");
    await page.waitForFunction(() => Boolean(window.__ipad?.mounted));
    assert.equal(await page.locator("#demo-banner").isVisible(), true);
    assert.equal(await page.locator("#main-window").isVisible(), true);
    assert.equal(await page.locator("#native-volume").isDisabled(), true);
    await page.locator("#settings-toggle").tap();
    await page.locator("#spotify-client-id").fill("0123456789abcdef0123456789abcdef");
    await page.locator("#spotify-settings button[type=submit]").tap();
    await page.waitForFunction(() => document.getElementById("diagnostics-status").textContent.includes("saved"));
    await page.locator("#settings-close").tap();
    await page.locator("#connect-button").tap();
    await page.locator("#spotify-link").fill("https://open.spotify.com/track/fixture123");
    await page.locator("#link-form button").tap();
    await page.locator("#spotify-shelf .music-play").waitFor();
    await page.locator("#spotify-shelf .music-play").tap();
    await page.waitForFunction(() => document.getElementById("track-title").textContent === "Demo track");
    await page.locator("#play-button").tap();
    await page.waitForFunction(() => window.__ipad.host.getCachedState().state === "paused");
    await page.locator("#local-source").tap();
    await page.locator("#import-button").tap();
    await page.locator("#local-library .music-play").waitFor();
    await page.locator("#local-library .music-play").tap();
    await page.waitForFunction(() => window.__ipad.host.getCachedState().provider === "local");
    assert.equal(await page.locator("#native-volume").isDisabled(), false);
    assert.match(await page.locator("#track-title").textContent(), /Imported demo/);
    const mobileSize = await page.locator("#play-button").boundingBox();
    assert.ok(mobileSize.width >= 44 && mobileSize.height >= 44);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.locator("#local-library .remove-item").tap();
    await page.waitForFunction(() => document.querySelectorAll("#local-library .music-play").length === 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(artifacts, "ipad-ui.png"), fullPage: true });
    const meta = JSON.parse(readFileSync(join(outdir, "metafile.json"), "utf8"));
    assert.equal(Object.keys(meta.inputs).some(input => /apps\/desktop\/|node_modules\/electron\//.test(input)), false);
    const report = { pass: true, browser: browser.version(), actualIPad: false, actualAudio: false, outdir, artifacts, tests: ["native demo gate", "shared player renders", "Spotify configuration and link shelf", "touch transport", "native file import contract", "provider-dependent volume", "library deletion", "no horizontal overflow", "no JS exceptions"] };
    writeFileSync(join(artifacts, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await context.close();
  } catch(error) {
    await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
    writeFileSync(join(artifacts, "failure.log"), `${error.stack}\n${errors.join("\n")}`);
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
