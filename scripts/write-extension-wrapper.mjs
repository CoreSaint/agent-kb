#!/usr/bin/env node
/** Write private deployed wrappers pinned to one fully verified staged runtime, DB, and domain. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const METADATA = new Set(["MANIFEST.json", "MANIFEST.sha256", "RUNTIME_IDENTITY", "WORKTREE_SNAPSHOT", "APPROVED_COMMIT", "RUNTIME_LABEL"]);
function die(message) { console.error(message); process.exit(2); }
function parseArgs(argv) {
  const out = { runtime: null, database: null, authorityDomain: null, cliDest: null, extensionDest: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runtime") out.runtime = argv[++i];
    else if (arg === "--database") out.database = argv[++i];
    else if (arg === "--authority-domain") out.authorityDomain = argv[++i];
    else if (arg === "--cli-dest") out.cliDest = argv[++i];
    else if (arg === "--extension-dest") out.extensionDest = argv[++i];
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/write-extension-wrapper.mjs --runtime <staged-runtime-root> --database <absolute-db-path> --authority-domain <UUID> [--cli-dest path] [--extension-dest path] [--force]\nWrites private CLI and Pi wrappers. An override is honored only when AGENT_KB_PATH and AGENT_KB_EXPECTED_DOMAIN are both non-empty. Cross-directory publication is rollback-safe, not globally atomic.");
      process.exit(0);
    } else die(`Unknown argument: ${arg}`);
  }
  if (!out.runtime || !out.database || !out.authorityDomain) die("--runtime, --database, and --authority-domain are required");
  if (!UUID.test(out.authorityDomain)) die("--authority-domain must be a UUID");
  return out;
}
function lstat(path) { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
function assertSafeParents(path, create = false) {
  const absolute = resolve(path); const parent = dirname(absolute); const parts = parent.split(sep); let current = parts[0] === "" ? sep : parts[0];
  for (let index = 1; index < parts.length; index++) {
    current = current === sep ? join(current, parts[index]) : join(current, parts[index]);
    const info = lstat(current);
    if (!info) {
      if (!create) die(`Missing destination directory: ${current}`);
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) die(`Unsafe destination directory: ${current}`);
  }
}
function walkRegular(root, dir = root, files = []) {
  const info = lstat(dir);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) die(`Unsafe runtime directory: ${relative(root, dir) || "."}`);
  if ((info.mode & 0o077) !== 0) die(`Runtime directory is group/world accessible: ${relative(root, dir) || "."}`);
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name); const child = lstat(path); const rel = relative(root, path);
    if (!child || child.isSymbolicLink()) die(`Symlink in runtime: ${rel}`);
    if ((child.mode & 0o077) !== 0) die(`Runtime entry is group/world accessible: ${rel}`);
    if (child.isDirectory()) walkRegular(root, path, files);
    else if (child.isFile()) files.push(rel);
    else die(`Non-regular runtime entry: ${rel}`);
  }
  return files;
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function verifiedRuntime(runtimeArg) {
  const runtime = realpathSync(resolve(runtimeArg)); const runtimeInfo = lstat(runtime);
  if (!runtimeInfo || runtimeInfo.isSymbolicLink() || !runtimeInfo.isDirectory()) die("Runtime must be a real directory.");
  const allFiles = walkRegular(runtime).sort();
  for (const entry of ["MANIFEST.json", "MANIFEST.sha256", "RUNTIME_IDENTITY"]) if (!allFiles.includes(entry)) die(`Runtime is missing ${entry}.`);
  const marker = allFiles.includes("WORKTREE_SNAPSHOT") ? "WORKTREE_SNAPSHOT" : allFiles.includes("APPROVED_COMMIT") ? "APPROVED_COMMIT" : null;
  if (!marker || (allFiles.includes("WORKTREE_SNAPSHOT") && allFiles.includes("APPROVED_COMMIT"))) die("Runtime has no unambiguous staging identity.");
  const manifestBody = readFileSync(join(runtime, "MANIFEST.json"), "utf8"); let manifest;
  try { manifest = JSON.parse(manifestBody); } catch { die("Runtime manifest is not valid JSON."); }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.some((entry) => !entry || typeof entry.path !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256))) die("Runtime manifest is malformed.");
  const paths = manifest.files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || [...paths].sort().some((path, index) => path !== paths[index]) || paths.some((path) => !path || path.split("/").some((part) => !part || part === "." || part === "..") || METADATA.has(path))) die("Runtime manifest paths are not canonical.");
  if (manifestBody !== `${JSON.stringify({ version: 1, files: manifest.files })}\n`) die("Runtime manifest is not canonical.");
  const expected = new Set([...paths, "MANIFEST.json", "MANIFEST.sha256", "RUNTIME_IDENTITY", marker, ...(allFiles.includes("RUNTIME_LABEL") ? ["RUNTIME_LABEL"] : [])]);
  if (allFiles.length !== expected.size || allFiles.some((path) => !expected.has(path))) die("Runtime contains files absent from its manifest.");
  for (const entry of manifest.files) {
    const target = join(runtime, entry.path); const info = lstat(target);
    if (!info || info.isSymbolicLink() || !info.isFile() || digest(readFileSync(target)) !== entry.sha256) die(`Runtime manifest verification failed: ${entry.path}`);
  }
  const manifestDigest = digest(manifestBody);
  if (readFileSync(join(runtime, "MANIFEST.sha256"), "utf8") !== `${manifestDigest}  MANIFEST.json\n`) die("Runtime manifest digest mismatch.");
  if (readFileSync(join(runtime, "RUNTIME_IDENTITY"), "utf8") !== `${manifestDigest}\n`) die("Runtime identity marker mismatch.");
  if (marker === "WORKTREE_SNAPSHOT" && readFileSync(join(runtime, marker), "utf8") !== `${manifestDigest}\n`) die("Worktree snapshot identity mismatch.");
  for (const entry of ["bin/kb", "extension/index.ts"]) {
    const info = lstat(join(runtime, entry));
    if (!info || info.isSymbolicLink() || !info.isFile()) die(`Missing or unsafe runtime entrypoint: ${entry}`);
  }
  return { runtime, manifestDigest, cliEntry: join(runtime, "bin/kb"), extensionEntry: join(runtime, "extension/index.ts") };
}
function destinationState(path, force) {
  assertSafeParents(path, true); const info = lstat(path);
  if (!info) return null;
  if (info.isSymbolicLink()) die(`Destination is a symlink: ${path}`);
  if (!info.isFile()) die(`Destination is not a regular file: ${path}`);
  if (!force) die(`Destination exists (pass --force to replace): ${path}`);
  return { body: readFileSync(path), mode: statSync(path).mode & 0o777 };
}
function temporary(path, body, mode) {
  const temp = join(dirname(path), `.${basename(path)}.agent-kb-${randomUUID()}.tmp`);
  writeFileSync(temp, body, { flag: "wx", mode }); chmodSync(temp, mode);
  return temp;
}
function restore(path, state) {
  if (state === null) { rmSync(path, { force: true }); return; }
  const temp = temporary(path, state.body, state.mode); renameSync(temp, path); chmodSync(path, state.mode);
}
function installPair(cli, extension, cliBody, extensionBody, force) {
  const cliState = destinationState(cli, force); const extensionState = destinationState(extension, force);
  let cliTemp; let extensionTemp;
  try {
    cliTemp = temporary(cli, cliBody, 0o700); extensionTemp = temporary(extension, extensionBody, 0o600);
    renameSync(cliTemp, cli); cliTemp = null; chmodSync(cli, 0o700);
    renameSync(extensionTemp, extension); extensionTemp = null; chmodSync(extension, 0o600);
  } catch (error) {
    if (cliTemp) rmSync(cliTemp, { force: true }); if (extensionTemp) rmSync(extensionTemp, { force: true });
    try { restore(cli, cliState); restore(extension, extensionState); } catch (rollback) { die(`Wrapper installation failed and rollback failed: ${rollback.message}`); }
    throw error;
  }
}
function main() {
  process.umask(0o077);
  const args = parseArgs(process.argv.slice(2)); const verified = verifiedRuntime(args.runtime);
  const database = resolve(args.database); const domain = args.authorityDomain.toLowerCase();
  const cliDest = resolve(args.cliDest || join(process.env.HOME || die("HOME required"), ".local/bin/kb"));
  const extensionDest = resolve(args.extensionDest || join(process.env.HOME || die("HOME required"), ".pi/agent/extensions/agent-kb/index.ts"));
  if (cliDest === extensionDest) die("CLI and extension destinations must differ.");
  const cliBody = `#!/usr/bin/env sh\nset -eu\nif [ -z "\${AGENT_KB_PATH:-}" ] || [ -z "\${AGENT_KB_EXPECTED_DOMAIN:-}" ]; then\n  if [ -z "\${AGENT_KB_PATH:-}" ]; then\n    AGENT_KB_PATH=${JSON.stringify(database)}\n    export AGENT_KB_PATH\n  fi\n  AGENT_KB_EXPECTED_DOMAIN=${JSON.stringify(domain)}\n  export AGENT_KB_EXPECTED_DOMAIN\nfi\nexec ${JSON.stringify(verified.cliEntry)} "$@"\n`;
  const extensionBody = `const installedPath = ${JSON.stringify(database)};\nconst installedDomain = ${JSON.stringify(domain)};\nif (!process.env.AGENT_KB_PATH?.trim() || !process.env.AGENT_KB_EXPECTED_DOMAIN?.trim()) {\n  process.env.AGENT_KB_PATH ||= installedPath;\n  process.env.AGENT_KB_EXPECTED_DOMAIN = installedDomain;\n}\nconst { default: extension } = await import(${JSON.stringify(pathToFileURL(verified.extensionEntry).href)});\nexport default extension;\n`;
  installPair(cliDest, extensionDest, cliBody, extensionBody, args.force);
  console.log(JSON.stringify({ ok: true, runtime: verified.runtime, manifest_sha256: verified.manifestDigest, database, authority_domain: domain, cli_wrapper: cliDest, extension_wrapper: extensionDest, cli_sha256: digest(cliBody), extension_sha256: digest(extensionBody) }, null, 2));
}
main();
