// Runs before the core loads (binary.ts imports it first): the native binary has no dist/ on disk,
// so it unpacks the core's templates to a cache dir and points the core there (scripts/shim.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
// Inlined by scripts/build.mjs (DSH_BINARY=1): { "templates/...": [mode, base64], "bundled/...": ... }
declare const __DSH_ASSETS__: Record<string, [number, string]>;

const files = __DSH_ASSETS__;
const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
const root = path.join(cache, "dsh", `assets-${hash}`);
if (!fs.existsSync(root)) {
  // unpack beside, then rename: parallel first runs never see a half-written dir
  const tmp = `${root}.${process.pid}.tmp`;
  for (const [rel, [mode, b64]] of Object.entries(files)) {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, "base64"), { mode });
  }
  try {
    fs.renameSync(tmp, root);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true }); // another run won the race
  }
}
// the core resolves templates from `<__dirname>/..`
(globalThis as { __DSH_DIST_DIR?: string }).__DSH_DIST_DIR = path.join(root, "chunks");
