// Gives the vendored core a __dirname in the ESM bundle (same trick as upstream's esbuild-shims.js).
// The native binary sets __DSH_DIST_DIR (src/binary-setup.ts): its templates live in a cache dir.
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
export const __dirname = globalThis.__DSH_DIST_DIR ?? dirname(fileURLToPath(import.meta.url));
