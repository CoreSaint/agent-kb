#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "agent-kb-wrapper-"));
const runtime = join(root, "runtime");
const database = join(root, "database.sqlite");
const domain = "33333333-3333-4333-8333-333333333333";
const overrideDomain = "44444444-4444-4444-8444-444444444444";
const cli = join(root, "bin/kb");
const extension = join(root, "extensions/agent-kb/index.ts");
const writer = resolve(import.meta.dirname, "write-extension-wrapper.mjs");
function run(command, args, env = {}) { return spawnSync(command, args, { env: { ...process.env, ...env }, encoding: "utf8" }); }
function writeRuntimeManifest() {
  const files = ["bin/kb", "extension/index.ts", "src/marker.ts"].map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(join(runtime, path))).digest("hex") }));
  const manifest = `${JSON.stringify({ version: 1, files })}\n`; const digest = createHash("sha256").update(manifest).digest("hex");
  writeFileSync(join(runtime, "MANIFEST.json"), manifest, { mode: 0o600 });
  writeFileSync(join(runtime, "MANIFEST.sha256"), `${digest}  MANIFEST.json\n`, { mode: 0o600 });
  writeFileSync(join(runtime, "RUNTIME_IDENTITY"), `${digest}\n`, { mode: 0o600 });
  writeFileSync(join(runtime, "APPROVED_COMMIT"), `${"a".repeat(40)}\n`, { mode: 0o600 });
  return digest;
}
try {
  mkdirSync(join(runtime, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(runtime, "extension"), { recursive: true, mode: 0o700 });
  mkdirSync(join(runtime, "src"), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtime, "bin/kb"), "#!/usr/bin/env sh\nprintf '%s|%s\\n' \"$AGENT_KB_PATH\" \"$AGENT_KB_EXPECTED_DOMAIN\"\n", { mode: 0o700 });
  chmodSync(join(runtime, "bin/kb"), 0o700);
  writeFileSync(join(runtime, "src/marker.ts"), 'export const MARKER = "immutable-src";\n', { mode: 0o600 });
  writeFileSync(join(runtime, "extension/index.ts"), 'import { MARKER } from "../src/marker.ts"; export default () => ({ marker: MARKER });\n', { mode: 0o600 });
  const manifestDigest = writeRuntimeManifest();
  const written = run(process.execPath, [writer, "--runtime", runtime, "--database", database, "--authority-domain", domain, "--cli-dest", cli, "--extension-dest", extension]);
  assert.equal(written.status, 0, written.stderr || written.stdout);
  assert.equal(JSON.parse(written.stdout).manifest_sha256, manifestDigest);
  assert.equal(statSync(cli).mode & 0o777, 0o700); assert.equal(statSync(extension).mode & 0o777, 0o600);
  assert.equal(run(cli, []).stdout.trim(), `${database}|${domain}`);
  const overridePath = join(root, "override.sqlite");
  assert.equal(run(cli, [], { AGENT_KB_PATH: overridePath }).stdout.trim(), `${overridePath}|${domain}`);
  assert.equal(run(cli, [], { AGENT_KB_PATH: overridePath, AGENT_KB_EXPECTED_DOMAIN: overrideDomain }).stdout.trim(), `${overridePath}|${overrideDomain}`);
  const body = readFileSync(extension, "utf8"); assert.match(body, /await import/); assert.match(body, /installedDomain/); assert.match(body, /file:/);
  const probe = run(process.execPath, ["-e", `const m = await import(${JSON.stringify(pathToFileURL(extension).href)}); console.log(JSON.stringify(m.default()));`]);
  assert.equal(probe.status, 0, probe.stderr || probe.stdout); assert.deepEqual(JSON.parse(probe.stdout), { marker: "immutable-src" });
  const target = join(root, "live-target"); writeFileSync(target, "preserve", { mode: 0o600 }); const linked = join(root, "linked-cli"); symlinkSync(target, linked);
  const symlinked = run(process.execPath, [writer, "--runtime", runtime, "--database", database, "--authority-domain", domain, "--cli-dest", linked, "--extension-dest", join(root, "second.ts"), "--force"]);
  assert.equal(symlinked.status, 2); assert.equal(readFileSync(target, "utf8"), "preserve", "force followed a destination symlink");
  const oldCli = Buffer.from("old-cli\n"); const oldExtension = Buffer.from("old-extension\n"); writeFileSync(cli, oldCli, { mode: 0o751 }); writeFileSync(extension, oldExtension, { mode: 0o640 });
  chmodSync(cli, 0o751); chmodSync(extension, 0o640);
  const preload = join(root, "fail-rename.cjs"); writeFileSync(preload, "const fs = require('node:fs'); const original = fs.renameSync; fs.renameSync = (from, to) => { if (to === process.env.FAIL_DEST) throw new Error('deterministic publish failure'); return original(from, to); };\n");
  const failed = run(process.execPath, ["--require", preload, writer, "--runtime", runtime, "--database", database, "--authority-domain", domain, "--cli-dest", cli, "--extension-dest", extension, "--force"], { FAIL_DEST: extension });
  assert.notEqual(failed.status, 0, "deterministic second publish failure did not fail");
  assert.deepEqual(readFileSync(cli), oldCli); assert.equal(statSync(cli).mode & 0o777, 0o751);
  assert.deepEqual(readFileSync(extension), oldExtension); assert.equal(statSync(extension).mode & 0o777, 0o640);
  writeFileSync(join(runtime, "src/marker.ts"), "tampered\n", { mode: 0o600 });
  const tampered = run(process.execPath, [writer, "--runtime", runtime, "--database", database, "--authority-domain", domain, "--cli-dest", join(root, "tampered-cli"), "--extension-dest", join(root, "tampered-extension")]);
  assert.equal(tampered.status, 2, "tampered manifest runtime was accepted");
  console.log(JSON.stringify({ ok: true, wrapper_runtime: runtime, path_only_override_retains_domain: true, paired_override_allowed: true, symlink_rejected: true, rollback_preserved: true, manifest_tamper_rejected: true }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
