// Production UI routing with a simulated native bridge; no device or audio claims.
const { chromium, webkit, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, sep } = require("node:path");
const assert = require("node:assert/strict");

const engine = process.env.IPAD_SMOKE_BROWSER || "chromium";
assert.ok(["chromium", "webkit"].includes(engine), "IPAD_SMOKE_BROWSER must be chromium or webkit");
const browserType = engine === "webkit" ? webkit : chromium;
const root = resolve(__dirname, "..");
const artifactRoot = process.env.IPAD_SMOKE_ARTIFACT_DIR ? resolve(process.env.IPAD_SMOKE_ARTIFACT_DIR) : tmpdir();
mkdirSync(artifactRoot, { recursive: true });
const artifacts = mkdtempSync(join(artifactRoot, `nostalgify-ipad-diagnostics-${engine}-`));
const outdir = join(artifacts, "build");
const buttons = ["diagnostics-button", "web-diagnostics-button"];
const skinCodes = ["skin_storage_unavailable", "skin_load_failed", "skin_preference_failed"];
const secret = "test-only-diagnostics-private-token";

async function routeBuild(page) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.protocol === "blob:" || url.protocol === "data:") return route.continue();
    if (url.hostname !== "nostalgify-diagnostics.test") return route.abort();
    const file = resolve(outdir, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(outdir + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: "Not found" });
    const contentType = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    return route.fulfill({ contentType, body: readFileSync(file) });
  });
}

async function recordUntrustedDetails(page) {
  await page.evaluate(({ codes, secret }) => {
    for (const code of codes) window.nostalgify.recordError(code, {
      event: "private_event", time: secret, message: secret,
      stack: `https://private.example/${secret}`, metadata: { filename: `${secret}.wsz` },
      requestId: secret, errorClass: "TypeError", source: "app.js", line: 42, column: 8,
    });
    window.nostalgify.recordError("private_token_value", {
      message: secret, source: `https://private.example/${secret}`, errorClass: secret,
    });
  }, { codes: skinCodes, secret });
}

function assertSafeEvents(events) {
  assert.ok(Array.isArray(events));
  assert.ok(events.length <= 150);
  const encoded = JSON.stringify(events);
  for (const value of [secret, "private_token_value", "private_event", "private.example", "metadata", "filename", "message", "stack"]) {
    assert.equal(encoded.includes(value), false, `diagnostics must omit ${value}`);
  }
  for (const code of skinCodes) {
    const event = events.find(row => row.code === code);
    assert.ok(event, `${code} must survive export`);
    assert.equal(event.event, "web_error");
    assert.equal(event.errorClass, "TypeError");
    assert.equal(event.source, "app.js");
    assert.equal(event.line, 42);
    assert.equal(event.column, 8);
    assert.ok(Number.isFinite(Date.parse(event.time)));
    assert.equal(event.requestId, undefined);
  }
  assert.ok(events.some(row => row.event === "web_error" && row.code === "unexpected"));
}

async function openSettings(page) {
  await routeBuild(page);
  await page.goto("https://nostalgify-diagnostics.test/?mock=1");
  await page.waitForFunction(() => document.documentElement.dataset.playerReady === "true");
  assert.equal(await page.locator("#demo-banner").isVisible(), false, "production cannot opt into the development mock");
  assert.equal(await page.evaluate(() => typeof window.__ipad), "undefined");
  await page.locator("#settings-toggle").click();
  for (const id of buttons) assert.equal(await page.locator(`#${id}`).isVisible(), true);
}

async function closeContext(context, page, name, passed) {
  try {
    if (!passed && page) {
      await page.screenshot({ path: join(artifacts, `${name}-failure.png`), fullPage: true })
        .catch(error => console.error("Could not capture failure screenshot:", error.message));
    }
    await context.tracing.stop({ path: join(artifacts, `${name}-trace.zip`) })
      .catch(error => console.error("Could not save browser trace:", error.message));
  } finally { await context.close(); }
}

async function nativeExports(browser) {
  const context = await browser.newContext({ ...devices["iPad Pro 11"], acceptDownloads: true });
  let page, passed = false;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    const downloads = [], errors = [];
    page.on("download", download => downloads.push(download));
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const state = { provider: "spotify", state: "stopped", running: false, sequence: 1, capabilities: {} };
      let pending;
      const fixture = window.__nativeDiagnostics = { calls: [], exports: [], pending: false };
      fixture.complete = outcome => {
        if (!pending) throw new Error("No native share is pending");
        const share = pending;
        pending = undefined;
        fixture.pending = false;
        if (outcome.code) share.reject(Object.assign(new Error(outcome.message), { code: outcome.code }));
        else share.resolve({ shared: outcome.shared });
      };
      window.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
      window.Capacitor = {
        PluginHeaders: [{ name: "NostalgifyNative", methods: [
          ...["getState", "getPreferences", "setPreferences", "listAudio", "getDiagnostics", "exportDiagnostics"].map(name => ({ name, rtype: "promise" })),
          { name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "callback" },
        ] }],
        nativeCallback: () => "diagnostics-test-listener",
        nativePromise: (plugin, method, options) => {
          fixture.calls.push({ plugin, method });
          switch (method) {
            case "getState": return Promise.resolve(state);
            case "getPreferences": return Promise.resolve({ value: {} });
            case "setPreferences": return Promise.resolve({ value: options.value });
            case "listAudio": return Promise.resolve({ items: [] });
            case "getDiagnostics": return Promise.resolve({ version: 1, events: [] });
            case "exportDiagnostics":
              fixture.exports.push(options);
              fixture.pending = true;
              return new Promise((resolve, reject) => { pending = { resolve, reject }; });
            default: return Promise.reject(new Error("Unexpected native call"));
          }
        },
      };
    });
    await openSettings(page);
    assert.equal(await page.evaluate(() => window.Capacitor.getPlatform()), "ios");
    assert.equal(await page.locator("#browser-banner").isVisible(), false);
    await recordUntrustedDetails(page);
    let count = 0;
    for (const id of buttons) {
      for (const outcome of ["success", "cancel", "reject"]) {
        const button = page.locator(`#${id}`);
        await button.click();
        await page.waitForFunction(() => window.__nativeDiagnostics.pending);
        count++;
        assert.equal(await page.evaluate(() => window.__nativeDiagnostics.exports.length), count);
        assert.equal(await button.getAttribute("aria-busy"), "true", "the button remains busy until native share dismissal");
        assert.equal(await page.locator("#diagnostics-status").textContent(), "Preparing diagnostics…");
        assert.equal(await page.locator("#error-message").isVisible(), false);
        await button.evaluate(element => element.click());
        assert.equal(await page.evaluate(() => window.__nativeDiagnostics.exports.length), count, "a repeated click must not open another native share");
        assertSafeEvents(await page.evaluate(() => window.__nativeDiagnostics.exports.at(-1).webEvents));
        const knownRejection = id === "diagnostics-button";
        await page.evaluate(value => window.__nativeDiagnostics.complete(value), outcome === "reject"
          ? { code: knownRejection ? "dialog_busy" : "private_token_value", message: secret }
          : { shared: outcome === "success" });
        await page.waitForFunction(id => !document.getElementById(id).hasAttribute("aria-busy"), id);
        assert.equal(await page.locator("#diagnostics-status").textContent(), outcome === "success" ? "Diagnostics exported." : outcome === "cancel" ? "Export closed." : "Diagnostics export failed. Try again.");
        if (outcome === "reject") {
          assert.equal(await page.locator("#error-message").isVisible(), true);
          assert.equal(await page.locator("#error-message").textContent(), knownRejection
            ? "Finish the current dialog first."
            : "The player could not complete that action. Check the connection and try again.");
        } else assert.equal(await page.locator("#error-message").isVisible(), false);
      }
    }
    assert.equal(await page.evaluate(() => window.__nativeDiagnostics.calls.filter(call => call.method === "getDiagnostics").length), 0, "both native buttons must use the native share method");
    assert.equal(downloads.length, 0, "native exports must never trigger a browser download, including after failure");
    assert.deepEqual(errors, []);
    passed = true;
  } finally { await closeContext(context, page, "native", passed); }
}

async function browserExports(browser) {
  const context = await browser.newContext({ ...devices["iPad Pro 11"], acceptDownloads: true });
  let page, passed = false;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    const errors = [], downloads = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("download", download => downloads.push(download));
    await openSettings(page);
    assert.equal(await page.evaluate(() => window.Capacitor.isNativePlatform()), false);
    assert.equal(await page.locator("#browser-banner").isVisible(), true);
    await recordUntrustedDetails(page);
    for (const id of buttons) {
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`#${id}`).click()]);
      assert.equal(download.suggestedFilename(), "nostalgify-diagnostics.json");
      assert.equal(await download.failure(), null);
      const report = JSON.parse(readFileSync(await download.path(), "utf8"));
      assert.equal(report.version, 1);
      assert.equal(report.native, null, "a browser without a plugin must export its web report");
      assertSafeEvents(report.web);
      await page.waitForFunction(id => !document.getElementById(id).hasAttribute("aria-busy"), id);
      assert.equal(await page.locator("#diagnostics-status").textContent(), "Diagnostics download started.");
      assert.equal(await page.locator("#error-message").isVisible(), false, "missing native plugin must not fail browser diagnostics export");
    }
    assert.equal(downloads.length, buttons.length);
    assert.deepEqual(errors, []);
    passed = true;
  } finally { await closeContext(context, page, "browser", passed); }
}

(async () => {
  let browser, passed = false;
  try {
    execFileSync(process.execPath, ["apps/ipad/scripts/build.mjs", "--outdir", outdir], { cwd: root, stdio: "inherit" });
    const system = engine === "chromium" ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (!existsSync(chromium.executablePath()) && existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined) : undefined;
    browser = await browserType.launch({ executablePath: system, headless: true, args: engine === "chromium" ? ["--no-sandbox", "--disable-crashpad-for-testing"] : [] });
    await nativeExports(browser);
    await browserExports(browser);
    passed = true;
    console.log(JSON.stringify({ pass: true, engine, production: true, native: "simulated", nativeShareOutcomes: 6, browserDownloads: 2,
      ...(process.env.IPAD_SMOKE_ARTIFACT_DIR ? { artifacts } : {}) }));
  } finally {
    await browser?.close();
    // Keep explicit artifact runs and all failures, including build/launch failures.
    if (passed && !process.env.IPAD_SMOKE_ARTIFACT_DIR) rmSync(artifacts, { recursive: true, force: true });
  }
})().catch(error => {
  writeFileSync(join(artifacts, "failure.txt"), String(error.stack || error));
  console.error(error);
  console.error(`Diagnostics browser artifacts retained at ${artifacts}`);
  process.exitCode = 1;
});
