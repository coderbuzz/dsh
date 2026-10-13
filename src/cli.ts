import { main } from "./main.js";

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

main(process.argv.slice(2), readStdin).then(
  // exitCode, not process.exit(): exit() drops stdout still queued on a pipe (cut at 64 KiB for large results).
  (code) => void (process.exitCode = code),
  (err) => {
    process.stderr.write(`dsh: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
);
