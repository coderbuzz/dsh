// Entry for the native binary (tov/dsh.tov). Differs from cli.ts where Tov's Node layer does:
// process.stdin streams nothing there (fs.readFileSync(0) works) and process.exitCode is ignored,
// so the exit code is returned to Tov's main().
import "./binary-setup.js";
import fs from "node:fs";
import { main } from "./main.js";

export async function runBinary(): Promise<number> {
  try {
    return await main(process.argv.slice(2), async () => (process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8")));
  } catch (err) {
    process.stderr.write(`dsh: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
