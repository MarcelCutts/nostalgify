import { build } from "esbuild";
import { mkdir, copyFile, cp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(app, "../..");
const outputFlag = process.argv.indexOf("--outdir");
const outdir = outputFlag >= 0 ? resolve(process.argv[outputFlag + 1]) : resolve(app, "dist");
await mkdir(outdir, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: [resolve(app, "src/main.js")], outdir, entryNames: "app",
  bundle: true, platform: "browser", format: "iife", target: ["safari17"],
  define: { __IPAD_DEVELOPMENT__: String(process.argv.includes("--dev")) },
  metafile: true, sourcemap: false, logLevel: "info",
});
await Promise.all([
  copyFile(resolve(app, "index.html"), resolve(outdir, "index.html")),
  copyFile(resolve(app, "src/shell.css"), resolve(outdir, "shell.css")),
  copyFile(resolve(root, "packages/player-ui/src/app.css"), resolve(outdir, "player.css")),
  cp(resolve(root, "packages/player-ui/src/assets"), resolve(outdir, "assets"), { recursive: true }),
  writeFile(resolve(outdir, "metafile.json"), JSON.stringify(result.metafile, null, 2) + "\n"),
]);
