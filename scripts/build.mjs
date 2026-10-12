// Bundles src/ + vendored core into dist/ and copies the core's runtime templates.
// The core resolves templates from `<dir of its chunk>/..`, so core code must land in
// dist/chunks/ (splitting with two entry points) and templates in dist/templates/.
import { build } from "esbuild";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const core = "vendor/deepcode-core";
rmSync("dist", { recursive: true, force: true });

const shim = "dist/.shim.js";
cpSync("scripts/shim.js", shim);

await build({
  entryPoints: ["src/index.ts", "src/cli.ts"],
  bundle: true,
  outdir: "dist",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  inject: [shim],
  logOverride: { "empty-import-meta": "silent" },
});
rmSync(shim);

cpSync(`${core}/templates`, "dist/templates", {
  recursive: true,
  filter: (src) => !src.includes("/templates/skills/bundled"),
});
cpSync(`${core}/templates/skills/bundled`, "dist/bundled", { recursive: true });
writeFileSync("dist/cli.js", "#!/usr/bin/env node\n" + readFileSync("dist/cli.js", "utf8"), { mode: 0o755 });
