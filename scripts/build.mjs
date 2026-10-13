// Bundles src/ + vendored core into dist/ and copies the core's runtime templates.
// The core resolves templates from `<dir of its chunk>/..`, so core code must land in
// dist/chunks/ (splitting with two entry points) and templates in dist/templates/.
// DSH_BINARY=1 adds dist/binary.js, the entry tov/dsh.tov compiles, with the templates embedded.
import { build } from "esbuild";
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const core = "vendor/deepcode-core";
rmSync("dist", { recursive: true, force: true });

const binary = process.env.DSH_BINARY === "1";
const assets = {};
if (binary) {
  // same layout as the copies below: templates/** without skills/bundled, which goes to bundled/
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? walk(`${dir}/${n}`) : [`${dir}/${n}`]));
  for (const file of walk(`${core}/templates`)) {
    const rel = file.slice(core.length + 1).replace("templates/skills/bundled/", "bundled/");
    assets[rel] = [statSync(file).mode & 0o777, readFileSync(file).toString("base64")];
  }
}

const shim = "dist/.shim.js";
cpSync("scripts/shim.js", shim);

await build({
  entryPoints: ["src/index.ts", "src/cli.ts", ...(binary ? ["src/binary.ts"] : [])],
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
  alias: binary ? { undici: "./scripts/undici-tov.js" } : {},
  define: binary ? { __DSH_ASSETS__: JSON.stringify(assets) } : {},
  logOverride: { "empty-import-meta": "silent" },
});
rmSync(shim);

cpSync(`${core}/templates`, "dist/templates", {
  recursive: true,
  filter: (src) => !src.includes("/templates/skills/bundled"),
});
cpSync(`${core}/templates/skills/bundled`, "dist/bundled", { recursive: true });
writeFileSync("dist/cli.js", "#!/usr/bin/env node\n" + readFileSync("dist/cli.js", "utf8"), { mode: 0o755 });
