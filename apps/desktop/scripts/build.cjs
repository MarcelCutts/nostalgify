const fs = require("node:fs/promises");
const path = require("node:path");
const { build } = require("esbuild");

const desktop = path.resolve(__dirname, "..");
const root = path.resolve(desktop, "../..");
const stage = path.join(desktop, "dist");

async function copy(from, to) {
  await fs.cp(path.join(root, from), path.join(stage, to), { recursive: true });
}

async function main() {
  const metadata = JSON.parse(await fs.readFile(path.join(desktop, "package.json"), "utf8"));
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  const bundled = await build({
    absWorkingDir: root,
    entryPoints: ["apps/desktop/src/renderer-entry/index.js"],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: path.join(stage, "renderer.js"),
    metafile: true,
    logLevel: "warning",
  });
  await fs.writeFile(path.join(stage, "metafile.json"), JSON.stringify(bundled.metafile, null, 2));
  await fs.writeFile(path.join(stage, "package.json"), JSON.stringify({
    name: "nostalgify", productName: "Nostalgify", version: metadata.version,
    private: true, main: "src/main/main.js", license: "MIT",
    description: "Classic Winamp skins for Spotify and SoundCloud on macOS.",
  }, null, 2) + "\n");
  await Promise.all([
    copy("apps/desktop/src/main", "src/main"),
    copy("apps/desktop/src/preload", "src/preload"),
    copy("packages/player-ui/src/index.html", "src/renderer/index.html"),
    copy("packages/player-ui/src/app.css", "src/renderer/app.css"),
    copy("packages/player-ui/src/assets", "src/renderer/assets"),
    // Development diagnostics resolve these relative to staged src/main. The
    // release packager excludes tests; packaged apps never use fixture mode.
    copy("tests/helpers", "tests/helpers"),
    copy("tests/fixtures", "tests/fixtures"),
    copy("LICENSE", "LICENSE"),
    copy("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
    copy("licenses", "licenses"),
    copy("skins", "skins"),
  ]);
  // The source test helper imports the desktop workspace. Inside the staged
  // application its dependency is the app-local main module instead.
  const liveHelper = path.join(stage, "tests/helpers/soundcloud-live.js");
  await fs.writeFile(liveHelper, (await fs.readFile(liveHelper, "utf8"))
    .replace("../../apps/desktop/src/main/spotify-selftest", "../../src/main/spotify-selftest"));
  // Preserve root/skins as the development folder while keeping the stage
  // independently runnable if it is moved away from this checkout.
  await fs.writeFile(path.join(stage, "development.json"), JSON.stringify({ skinsDir: path.join(root, "skins") }) + "\n");
  console.log(`Built desktop application: ${stage}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
