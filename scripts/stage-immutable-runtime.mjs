#!/usr/bin/env node
/** Materialize a private, self-contained runtime from a commit or verified worktree snapshot. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = /^(?:release|node_modules|dist|build|\.tmp)(?:\/|$)|(?:^|\/)(?:\.agent-kb)(?:\/|$)|(?:\.sqlite(?:-(?:wal|shm))?$|\.log$)/u;
const SECRET_LIKE = /(?:^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential|token|password)[^/]*)$/iu;
const METADATA = new Set(["MANIFEST.json", "MANIFEST.sha256", "RUNTIME_IDENTITY", "WORKTREE_SNAPSHOT", "APPROVED_COMMIT", "RUNTIME_LABEL"]);
function die(message) { console.error(message); process.exit(2); }
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.status !== 0) die(`${cmd} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}
function parseArgs(argv) {
  const out = { commit: null, snapshot: false, label: null, root: null, repo: repoRoot, includeUntracked: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--commit") out.commit = argv[++i];
    else if (arg === "--worktree-snapshot") out.snapshot = true;
    else if (arg === "--include-untracked") out.includeUntracked.push(argv[++i]);
    else if (arg === "--label") out.label = argv[++i];
    else if (arg === "--root") out.root = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/stage-immutable-runtime.mjs (--commit <full-sha> | --worktree-snapshot) [--include-untracked <repo-relative-path>]... [--label name] [--root dir] [--repo path]\nStages a private runtime. Worktree snapshots include tracked files only unless an unignored regular path is explicitly included.");
      process.exit(0);
    } else die(`Unknown argument: ${arg}`);
  }
  if (out.snapshot === Boolean(out.commit)) die("Specify exactly one of --commit or --worktree-snapshot.");
  if (out.commit && !/^[0-9a-f]{40}$/iu.test(out.commit)) die("--commit must be a full 40-char git SHA");
  if (out.includeUntracked.some((path) => !path)) die("--include-untracked requires a path");
  return out;
}
function lstat(path) { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
function assertPrivateTree(path, allowMissingLeaf = false) {
  const absolute = resolve(path); const parts = absolute.split(sep); let current = parts[0] === "" ? sep : parts[0];
  for (let index = 1; index < parts.length; index++) {
    current = current === sep ? join(current, parts[index]) : join(current, parts[index]);
    const info = lstat(current);
    if (!info && allowMissingLeaf && index === parts.length - 1) return;
    if (!info) die(`Missing path component: ${current}`);
    if (info.isSymbolicLink() || !info.isDirectory()) die(`Unsafe path component: ${current}`);
  }
}
function walkFiles(dir, base = dir, files = []) {
  const info = lstat(dir);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) die(`Unsafe staged directory: ${dir}`);
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name); const child = lstat(path);
    if (!child || child.isSymbolicLink()) die(`Symlink in staged runtime: ${relative(base, path)}`);
    if (child.isDirectory()) walkFiles(path, base, files);
    else if (child.isFile()) files.push(relative(base, path));
    else die(`Non-regular file in staged runtime: ${relative(base, path)}`);
  }
  return files;
}
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function assertEntrypoints(dest) {
  for (const rel of ["src/cli.ts", "extension/index.ts", "bin/kb"]) {
    const path = join(dest, rel); const info = lstat(path);
    if (!info || info.isSymbolicLink() || !info.isFile()) die(`Missing or unsafe runtime entrypoint: ${rel}`);
    const check = rel === "bin/kb" ? spawnSync("sh", ["-n", path], { encoding: "utf8" }) : spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    if (check.status !== 0) die(`Entrypoint validation failed for ${rel}:\n${check.stderr}`);
  }
  for (const rel of walkFiles(dest)) {
    if (!/\.(?:ts|mjs|js)$/u.test(rel)) continue;
    if (/from\s+["']\/[^"']*\/agent-kb\/src\//u.test(readFileSync(join(dest, rel), "utf8"))) die(`Mutable absolute source import remains: ${rel}`);
  }
}
function lockRuntime(dest) {
  for (const rel of walkFiles(dest)) chmodSync(join(dest, rel), rel === "bin/kb" ? 0o700 : 0o600);
  const lockDirectories = (dir) => {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstat(path).isDirectory()) lockDirectories(path);
    }
  };
  lockDirectories(dest);
}
function safeRelative(repo, rel) {
  if (!rel || rel.includes("\0") || rel.split("/").some((part) => !part || part === "." || part === "..") || FORBIDDEN.test(rel)) die(`Forbidden snapshot path: ${rel}`);
  const source = resolve(repo, rel);
  if (!source.startsWith(`${repo}${sep}`)) die(`Snapshot source escaped repository: ${rel}`);
  return source;
}
function snapshotPaths(repo, requested) {
  const tracked = new Set(run("git", ["-C", repo, "ls-files", "-z"]).split("\0").filter(Boolean));
  const untracked = new Set(run("git", ["-C", repo, "ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
  const paths = [...tracked].filter((path) => !FORBIDDEN.test(path));
  for (const rel of requested) {
    if (SECRET_LIKE.test(rel)) die(`Secret-like untracked files cannot be staged: ${rel}`);
    if (tracked.has(rel)) die(`--include-untracked is only for untracked files: ${rel}`);
    if (!untracked.has(rel)) die(`Untracked file is ignored, missing, or not repository-local: ${rel}`);
    paths.push(rel);
  }
  return [...new Set(paths)].sort();
}
function sourceRecord(repo, rel) {
  const source = safeRelative(repo, rel); const info = lstat(source);
  if (!info || info.isSymbolicLink() || !info.isFile()) die(`Snapshot source is not a regular file: ${rel}`);
  return { path: rel, sha256: sha256(source) };
}
function copySnapshot(repo, dest, records) {
  for (const { path: rel } of records) {
    const source = safeRelative(repo, rel); const info = lstat(source);
    if (!info || info.isSymbolicLink() || !info.isFile()) die(`Snapshot source changed type while staging: ${rel}`);
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, { dereference: false, force: false, preserveTimestamps: false });
    chmodSync(target, 0o600);
  }
}
function assertSnapshotStable(repo, dest, records) {
  for (const record of records) {
    const source = sourceRecord(repo, record.path); const staged = lstat(join(dest, record.path));
    if (source.sha256 !== record.sha256 || !staged || staged.isSymbolicLink() || !staged.isFile() || sha256(join(dest, record.path)) !== record.sha256) die(`Worktree content changed while staging: ${record.path}`);
  }
}
function writeManifest(dest) {
  const files = walkFiles(dest).filter((path) => !METADATA.has(path)).sort().map((path) => ({ path, sha256: sha256(join(dest, path)) }));
  const body = `${JSON.stringify({ version: 1, files })}\n`;
  const digest = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(dest, "MANIFEST.json"), body, { mode: 0o600 });
  writeFileSync(join(dest, "MANIFEST.sha256"), `${digest}  MANIFEST.json\n`, { mode: 0o600 });
  return { fileCount: files.length, digest };
}
function publish(root, temporary, identity) {
  const dest = join(root, identity); const existing = lstat(dest);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) die(`Unsafe runtime collision destination: ${dest}`);
    const existingFiles = walkFiles(dest).sort(); const stagedFiles = walkFiles(temporary).sort();
    if (existingFiles.length !== stagedFiles.length || existingFiles.some((path, index) => path !== stagedFiles[index] || !readFileSync(join(existing, path)).equals(readFileSync(join(temporary, path))))) die(`Destination collision has different verified content: ${dest}`);
    rmSync(temporary, { recursive: true, force: true });
    return dest;
  }
  renameSync(temporary, dest);
  return dest;
}
function main() {
  process.umask(0o077);
  const args = parseArgs(process.argv.slice(2));
  const repo = realpathSync(args.repo); assertPrivateTree(repo);
  const root = resolve(args.root || join(process.env.HOME || die("HOME required"), ".local/share/agent-kb/runtimes"));
  mkdirSync(root, { recursive: true, mode: 0o700 }); assertPrivateTree(root);
  const before = args.snapshot ? run("git", ["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"]) : null;
  const commit = args.commit ? run("git", ["-C", repo, "rev-parse", `${args.commit}^{commit}`]).trim().toLowerCase() : null;
  if (args.commit && commit !== args.commit.toLowerCase()) die(`rev-parse mismatch: got ${commit}, expected ${args.commit}`);
  const temporary = join(root, `.stage-${randomUUID()}`); mkdirSync(temporary, { mode: 0o700 });
  try {
    if (args.snapshot) {
      const records = snapshotPaths(repo, args.includeUntracked).map((path) => sourceRecord(repo, path));
      copySnapshot(repo, temporary, records);
      const after = run("git", ["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"]);
      assertSnapshotStable(repo, temporary, records);
      if (after !== before) die("Worktree status changed while staging; snapshot discarded.");
    } else {
      const archive = spawnSync("git", ["-C", repo, "archive", "--format=tar", commit], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      if (archive.status !== 0) die(`git archive failed: ${archive.stderr?.toString() || ""}`);
      const tar = spawnSync("tar", ["-x", "-C", temporary], { input: archive.stdout, encoding: "buffer" });
      if (tar.status !== 0) die(`tar extract failed: ${tar.stderr?.toString() || ""}`);
    }
    lockRuntime(temporary);
    assertEntrypoints(temporary);
    const manifest = writeManifest(temporary);
    const identity = manifest.digest;
    writeFileSync(join(temporary, "RUNTIME_IDENTITY"), `${identity}\n`, { mode: 0o600 });
    writeFileSync(join(temporary, args.snapshot ? "WORKTREE_SNAPSHOT" : "APPROVED_COMMIT"), `${args.snapshot ? identity : commit}\n`, { mode: 0o600 });
    if (args.label) writeFileSync(join(temporary, "RUNTIME_LABEL"), `${args.label}\n`, { mode: 0o600 });
    const dest = publish(root, temporary, identity);
    console.log(JSON.stringify({ ok: true, source: args.snapshot ? "worktree-snapshot" : "commit", identity, dest, label: args.label, manifest_sha256: manifest.digest, file_count: manifest.fileCount }, null, 2));
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}
main();
