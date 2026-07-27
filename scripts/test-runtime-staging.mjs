#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-kb-stage-"));
const repo = join(root, "repo");
const output = join(root, "runtimes");
const stage = resolve(import.meta.dirname, "stage-immutable-runtime.mjs");
function command(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repo, encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
}
function stageSnapshot(args = []) {
  const result = spawnSync(process.execPath, [stage, "--worktree-snapshot", "--repo", repo, "--root", output, ...args], { env: { ...process.env, HOME: join(root, "home") }, encoding: "utf8" });
  return result;
}
try {
  mkdirSync(join(repo, "src"), { recursive: true, mode: 0o700 }); mkdirSync(join(repo, "extension"), { mode: 0o700 }); mkdirSync(join(repo, "bin"), { mode: 0o700 });
  writeFileSync(join(repo, "src/cli.ts"), "export const cli = true;\n", { mode: 0o600 });
  writeFileSync(join(repo, "extension/index.ts"), "export default {};\n", { mode: 0o600 });
  writeFileSync(join(repo, "bin/kb"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o700 });
  command("git", ["init", "--quiet", "--initial-branch=main"]); command("git", ["config", "user.email", "test@example.invalid"]); command("git", ["config", "user.name", "Test"]); command("git", ["add", "."]); command("git", ["commit", "--quiet", "-m", "fixture"]);
  writeFileSync(join(repo, "unexpected.txt"), "not staged by default\n", { mode: 0o600 });
  let result = stageSnapshot(); assert.equal(result.status, 0, result.stderr || result.stdout); const first = JSON.parse(result.stdout);
  assert.equal(first.source, "worktree-snapshot"); assert.ok(existsSync(join(first.dest, "WORKTREE_SNAPSHOT"))); assert.ok(existsSync(join(first.dest, "MANIFEST.json"))); assert.equal(existsSync(join(first.dest, "unexpected.txt")), false, "default snapshot included untracked file");
  assert.match(readFileSync(join(first.dest, "MANIFEST.sha256"), "utf8"), /^[0-9a-f]{64}  MANIFEST\.json\n$/u);
  writeFileSync(join(repo, "extra.ts"), "export const extra = true;\n", { mode: 0o600 });
  result = stageSnapshot(["--include-untracked", "extra.ts"]); assert.equal(result.status, 0, result.stderr || result.stdout); const included = JSON.parse(result.stdout); assert.ok(existsSync(join(included.dest, "extra.ts")));
  writeFileSync(join(repo, ".env"), "SECRET=value\n", { mode: 0o600 }); result = stageSnapshot(["--include-untracked", ".env"]); assert.equal(result.status, 2, "secret-like untracked file was accepted");
  writeFileSync(join(repo, "src/cli.ts"), "export const cli = 'first change';\n", { mode: 0o600 }); result = stageSnapshot(); assert.equal(result.status, 0, result.stderr || result.stdout); const changed = JSON.parse(result.stdout);
  writeFileSync(join(repo, "src/cli.ts"), "export const cli = 'second change';\n", { mode: 0o600 }); result = stageSnapshot(); assert.equal(result.status, 0, result.stderr || result.stdout); const changedAgain = JSON.parse(result.stdout);
  assert.notEqual(changed.identity, changedAgain.identity, "same git status produced a colliding runtime identity");
  const symlinkRepo = join(root, "symlink-repo"); command("cp", ["-a", repo, symlinkRepo], { cwd: root }); rmSync(join(symlinkRepo, ".git"), { recursive: true, force: true });
  const git = (args) => { const r = spawnSync("git", args, { cwd: symlinkRepo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr || r.stdout); };
  git(["init", "--quiet", "--initial-branch=main"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Test"]); rmSync(join(symlinkRepo, ".env")); rmSync(join(symlinkRepo, "unexpected.txt")); rmSync(join(symlinkRepo, "extra.ts")); symlinkSync("/etc/passwd", join(symlinkRepo, "external-link")); git(["add", "."]); git(["commit", "--quiet", "-m", "symlink fixture"]);
  const symlinked = spawnSync(process.execPath, [stage, "--worktree-snapshot", "--repo", symlinkRepo, "--root", join(root, "symlink-output")], { env: { ...process.env, HOME: join(root, "home") }, encoding: "utf8" }); assert.equal(symlinked.status, 2, "tracked external symlink was accepted");
  assert.equal(lstatSync(join(first.dest, "src/cli.ts")).isSymbolicLink(), false);
  console.log(JSON.stringify({ ok: true, default_tracked_only: true, explicit_untracked_verified: true, secret_rejected: true, symlink_rejected: true, distinct_content_identities: true, manifest_sha256: first.manifest_sha256 }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
