// Gives the vendored core a __dirname in the ESM bundle (same trick as upstream's esbuild-shims.js).
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
export const __dirname = dirname(fileURLToPath(import.meta.url));
