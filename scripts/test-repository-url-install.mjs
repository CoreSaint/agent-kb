#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

process.umask(0o077);

const repository = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "agent-kb-repository-install-"));
const source = join(root, "synthetic-source");
const home = join(root, "home");
const destination = join(root, "installed-vault");
const existingDestination = join(root, "existing-vault");
const baseEnv = {
  ...process.env,
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "agent-kb test",
  GIT_AUTHOR_EMAIL: "agent-kb-test@example.invalid",
  GIT_COMMITTER_NAME: "agent-kb test",
  GIT_COMMITTER_EMAIL: "agent-kb-test@example.invalid",
  npm_config_offline: "true",
};
delete baseEnv.AGENT_KB_PATH;
delete baseEnv.AGENT_KB_EXPECTED_DOMAIN;
assert.ok(resolve(home).startsWith(`${resolve(root)}/`));

function run(program, args, options = {}) {
  return spawnSync(program, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? baseEnv,
    encoding: "utf8",
  });
}

function copyRepositorySource() {
  cpSync(repository, source, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    filter: (from) => {
      const name = basename(from);
      const relative = from === repository ? "" : from.slice(repository.length + 1);
      if (relative === "") return true;
      if ([".git", "release", "node_modules", "dist", "build", ".tmp", ".coverage"].includes(name)) return false;
      if (relative.split("/").includes(".agent-kb")) return false;
      if (/\.sqlite(?:-(?:wal|shm))?$|\.log$/u.test(name)) return false;
      return true;
    },
  });
}

function git(args, cwd) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function initializeSyntheticGitSource() {
  copyRepositorySource();
  git(["init", "--quiet", "--initial-branch=main"], source);
  git(["add", "."], source);
  git(["commit", "--quiet", "-m", "synthetic source"], source);
}

function installFromRepositoryUrl(sourceUrl, requestedDestination) {
  if (existsSync(requestedDestination) || (existsSync(requestedDestination) === false && (() => { try { return lstatSync(requestedDestination).isSymbolicLink(); } catch { return false; } })())) {
    return { status: 1, stderr: `destination already exists: ${requestedDestination}\n`, cloned: false };
  }
  const bootstrap = mkdtempSync(join(root, "bootstrap-"));
  const checkout = join(bootstrap, "agent-kb");
  const extract = join(bootstrap, "extract");
  try {
    const clone = run("git", ["clone", "--quiet", sourceUrl, checkout]);
    if (clone.status !== 0) return { status: clone.status, stdout: clone.stdout, stderr: clone.stderr, bootstrap, cloned: true };

    const build = run("npm", ["run", "build:release"], { cwd: checkout });
    if (build.status !== 0) return { status: build.status, stdout: build.stdout, stderr: build.stderr, bootstrap, cloned: true };

    const releaseFiles = readdirSync(join(checkout, "release")).filter((name) => name.endsWith(".tar.gz"));
    assert.equal(releaseFiles.length, 1, `expected one release archive, got ${releaseFiles.join(", ")}`);
    const archive = join(checkout, "release", releaseFiles[0]);
    mkdirSync(extract, { mode: 0o700 });
    const untar = run("tar", ["-xzf", archive, "-C", extract]);
    if (untar.status !== 0) return { status: untar.status, stdout: untar.stdout, stderr: untar.stderr, bootstrap, cloned: true };

    const topLevels = readdirSync(extract);
    assert.equal(topLevels.length, 1, `expected one extracted release root, got ${topLevels.join(", ")}`);
    const releaseRoot = join(extract, topLevels[0]);
    const install = run(join(releaseRoot, "install.sh"), [requestedDestination]);
    if (install.status !== 0) return { status: install.status, stdout: install.stdout, stderr: install.stderr, bootstrap, cloned: true };

    const checkoutStatus = git(["status", "--short"], checkout).stdout;
    const checkoutIgnoredRelease = git(["status", "--short", "--ignored", "release"], checkout).stdout;
    const parsed = JSON.parse(install.stdout);
    rmSync(bootstrap, { recursive: true, force: true });
    return { status: 0, stdout: install.stdout, report: parsed, archive: releaseFiles[0], bootstrap, checkoutStatus, checkoutIgnoredRelease, cleanup: !existsSync(bootstrap), cloned: true };
  } catch (error) {
    return { status: 1, stderr: error instanceof Error ? error.message : String(error), bootstrap, cloned: true };
  }
}

let report;
try {
  mkdirSync(home, { mode: 0o700 });
  initializeSyntheticGitSource();

  mkdirSync(existingDestination, { mode: 0o700 });
  const refused = installFromRepositoryUrl(source, existingDestination);
  assert.notEqual(refused.status, 0, "repository install accepted existing destination");
  assert.equal(refused.cloned, false, "existing destination should be refused before cloning");
  assert.match(refused.stderr, /destination already exists/);
  assert.deepEqual(readdirSync(existingDestination), [], "existing destination was modified");

  const installed = installFromRepositoryUrl(source, destination);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(installed.cleanup, true, "successful bootstrap was not cleaned up");
  assert.match(installed.archive, new RegExp(`^${pkg.name}-${pkg.version}-${process.platform}-${process.arch}\\.tar\\.gz$`));
  assert.equal(installed.checkoutStatus, "", "release build mutated tracked clone files");
  assert.match(installed.checkoutIgnoredRelease, /!! release\//, "release output was not ignored in clone");
  assert.equal(installed.report.ok, true);
  assert.equal(installed.report.version, pkg.version);
  assert.equal(installed.report.destination, resolve(destination));
  assert.equal(installed.report.database, join(resolve(destination), ".agent-kb", "kb.sqlite"));
  assert.equal(installed.report.skill, join(home, ".agents", "skills", "agent-memory-vault", "SKILL.md"));

  const status = run(join(destination, "kb"), ["status", "--json"], { cwd: destination });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const statusEnvelope = JSON.parse(status.stdout);
  assert.equal(statusEnvelope.ok, true);
  assert.equal(statusEnvelope.data.path, join(resolve(destination), ".agent-kb", "kb.sqlite"));
  assert.equal(statusEnvelope.data.schemaVersion, 2);
  assert.equal(statSync(join(destination, ".agent-kb")).mode & 0o777, 0o700);
  assert.equal(statSync(join(destination, ".agent-kb", "kb.sqlite")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(destination, "INIT.md")), false, "installer left INIT.md after verified install");
  assert.equal(existsSync(join(source, "vault", ".agent-kb")), false, "synthetic source vault was initialized");
  assert.equal(existsSync(join(source, "release")), false, "synthetic source was built in place");

  report = {
    ok: true,
    source: "local synthetic git repository",
    archive: installed.archive,
    destination,
    database: statusEnvelope.data.path,
    skill: installed.report.skill,
    existing_destination_refused_before_clone: true,
    bootstrap_cleanup: installed.cleanup,
    network_used: false,
    real_home_used: false,
    source_vault_touched: false,
    cleanup: false,
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "repository install test cleanup failed");
console.log(JSON.stringify({ ...report, cleanup: true }, null, 2));
