const { spawnSync } = require("node:child_process");
const { mkdirSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const regressions = readdirSync(join(root, "tests"))
  .filter(name => /^ipad-.+\.browser\.(cjs|mjs)$/.test(name))
  .sort();
const artifactRoot = process.env.IPAD_SMOKE_ARTIFACT_DIR;

for (const name of ["ipad-smoke.cjs", ...regressions]) {
  const env = { ...process.env };
  if (artifactRoot) {
    env.IPAD_SMOKE_ARTIFACT_DIR = resolve(root, artifactRoot, name.replace(/\.(cjs|mjs)$/, ""));
    mkdirSync(env.IPAD_SMOKE_ARTIFACT_DIR, { recursive: true });
  }
  console.log(`Running ${name} (${env.IPAD_SMOKE_BROWSER || "chromium"})`);
  const result = spawnSync(process.execPath, [join(root, "tests", name)], {
    cwd: root, env, stdio: "inherit",
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status || 1);
}
