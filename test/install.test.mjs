// install.sh against the package exactly as npm would publish it (npm pack), into temp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
// `npm publish` runs this via prepublishOnly and leaks npm_* config (dry-run, command, ...) into child npm calls.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_")));
const script = path.resolve("install.sh");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

test("install.sh: install, rerun, refuse to overwrite, uninstall", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-inst-"));
  const packed = await run("npm", ["pack", "--pack-destination", tmp, "--ignore-scripts"], { env: cleanEnv });
  const name = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  assert.ok(name, `npm pack made no tarball:\n${packed.stdout}\n${packed.stderr}`);
  const tarball = path.join(tmp, name);
  const prefix = path.join(tmp, "prefix");
  const bin = path.join(tmp, "bin");
  const env = { ...cleanEnv, DSH_PACKAGE: tarball, HOME: tmp };
  const install = (...args) => run("sh", [script, "--prefix", prefix, "--bin-dir", bin, ...args], { env });

  const first = await install();
  assert.match(first.stdout, new RegExp(`Installed dsh ${version.replaceAll(".", "\\.")} `));
  assert.match(first.stdout, /not on your PATH/, "hints when bin dir is not on PATH");
  assert.equal(fs.readlinkSync(path.join(bin, "dsh")), path.join(prefix, "bin", "dsh"));
  assert.equal((await run(path.join(bin, "dsh"), ["--version"])).stdout.trim(), version);

  await install(); // idempotent
  assert.equal((await run(path.join(bin, "dsh"), ["--version"])).stdout.trim(), version);

  const onPath = await run("sh", [script, "--prefix", prefix, "--bin-dir", bin], { env: { ...env, PATH: `${bin}:${process.env.PATH}` } });
  assert.doesNotMatch(onPath.stdout, /not on your PATH/);

  // an unrelated `dsh` in another bin dir must survive uninstall
  const other = path.join(tmp, "other");
  fs.mkdirSync(other);
  fs.symlinkSync("/bin/true", path.join(other, "dsh"));
  await run("sh", [script, "--uninstall", "--prefix", prefix, "--bin-dir", other], { env });
  assert.ok(fs.existsSync(path.join(other, "dsh")), "unrelated link kept");

  // a regular file at the link location is never overwritten
  const clash = path.join(tmp, "clash");
  fs.mkdirSync(clash);
  fs.writeFileSync(path.join(clash, "dsh"), "mine");
  await assert.rejects(run("sh", [script, "--prefix", path.join(tmp, "p2"), "--bin-dir", clash], { env }), /not a symlink/);
  assert.equal(fs.readFileSync(path.join(clash, "dsh"), "utf8"), "mine");

  const gone = await run("sh", [script, "--uninstall", "--prefix", prefix, "--bin-dir", bin], { env });
  assert.match(gone.stdout, /removed/);
  assert.ok(!fs.existsSync(path.join(bin, "dsh")) && !fs.existsSync(prefix));
});

test("install.sh: rejects unknown options", async () => {
  await assert.rejects(run("sh", [script, "--bogus"]), /unknown option/);
});
