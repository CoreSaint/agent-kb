#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

process.umask(0o077);

const repository = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
const host = `${process.platform}-${process.arch}`;
const releaseName = `${pkg.name}-${pkg.version}-${host}`;
const archiveName = `${releaseName}.tar.gz`;
const archivePath = join(repository, "release", archiveName);
const root = mkdtempSync(join(tmpdir(), "agent-kb-release-package-"));
const extractRoot = join(root, "extract");
const home = join(root, "home");
const destination = join(root, "installed-vault");
const conflictDestination = join(root, "conflict-vault");
const existingDestination = join(root, "existing-vault");
const noHomeDestination = join(root, "no-home-vault");
const badSkillHome = join(root, "bad-skill-home");
const badSkillDestination = join(root, "bad-skill-vault");
const danglingDestination = join(root, "dangling-destination");
const danglingSkillHome = join(root, "dangling-skill-home");
const danglingSkillDestination = join(root, "dangling-skill-vault");
const invalidSkillHome = join(root, "invalid-skill-home");
const invalidSkillDestination = join(root, "invalid-skill-vault");
const danglingComponentHome = join(root, "dangling-component-home");
const danglingComponentDestination = join(root, "dangling-component-vault");
const realHome = process.env.HOME ?? "";
const environment = {
  ...process.env,
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  npm_config_offline: "true",
};
delete environment.AGENT_KB_PATH;
delete environment.AGENT_KB_EXPECTED_DOMAIN;
assert.ok(resolve(home).startsWith(`${resolve(root)}/`));

function run(program, args, options = {}) {
  return spawnSync(program, args, {
    cwd: options.cwd ?? repository,
    env: options.env ?? environment,
    encoding: "utf8",
  });
}

function machine(result) {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "", `machine stderr was not empty: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function listFiles(path) {
  return readdirSync(path, { recursive: true, encoding: "utf8", withFileTypes: true })
    .map((entry) => relative(path, join(entry.parentPath, entry.name)))
    .sort();
}

function scanExtractedFiles(path) {
  const files = [];
  for (const entry of readdirSync(path, { recursive: true, encoding: "utf8", withFileTypes: true })) {
    const fullPath = join(entry.parentPath, entry.name);
    const rel = relative(path, fullPath);
    if (entry.isFile()) files.push({ rel, fullPath });
  }
  return files;
}

function stagingDirectories() {
  return new Set(readdirSync(tmpdir(), { encoding: "utf8" }).filter((name) => name.startsWith("agent-kb-release-staging-")));
}

let report;
try {
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(extractRoot, { mode: 0o700 });

  mkdirSync(join(repository, "release"), { recursive: true });
  writeFileSync(archivePath, "previous-good-archive\n", { mode: 0o600 });

  const stagingBeforeFailure = stagingDirectories();
  const failingBuild = run(process.execPath, [join(repository, "scripts", "build-release.mjs")], { env: { ...environment, PATH: "/nonexistent" } });
  assert.notEqual(failingBuild.status, 0, "build succeeded without tar in PATH");
  assert.deepEqual(stagingDirectories(), stagingBeforeFailure, "failed build leaked a staging directory");
  assert.equal(readFileSync(archivePath, "utf8"), "previous-good-archive\n", "failed build replaced the previous archive");

  const build = run(process.execPath, [join(repository, "scripts", "build-release.mjs")]);
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const buildReport = JSON.parse(build.stdout);
  assert.equal(buildReport.name, archiveName);
  assert.equal(buildReport.version, pkg.version);
  assert.equal(buildReport.host, host);
  assert.ok(existsSync(archivePath), "release archive was not created");

  const tarList = run("tar", ["-tzf", archivePath]);
  assert.equal(tarList.status, 0, tarList.stderr);
  const members = tarList.stdout.trim().split("\n").filter(Boolean).sort();
  assert.ok(members.every((member) => member === releaseName || member.startsWith(`${releaseName}/`)), "archive has unexpected top-level entries");
  for (const required of ["install.sh", "VERSION", "vault/CONTRACT.md", "vault/MAP.md", "vault/kb", "tool/bin/kb", "tool/src/cli.ts", "tool/skills/agent-memory-vault/SKILL.md"]) {
    assert.ok(members.includes(`${releaseName}/${required}`), `archive is missing ${required}`);
  }
  const forbiddenPath = /(?:^|\/)\.git(?:\/|$)|(?:^|\/)\.agent-kb(?:\/|$)|(?:^|\/)node_modules(?:\/|$)|(?:^|\/)release(?:\/|$)|(?:^|\/)dist(?:\/|$)|(?:^|\/)build(?:\/|$)|(?:^|\/)\.tmp(?:\/|$)|\.sqlite(?:-(?:wal|shm))?$|\.log$/u;
  assert.equal(members.some((member) => forbiddenPath.test(member)), false, "archive includes forbidden state or generated content");

  const tarHeaders = run("tar", ["--numeric-owner", "--full-time", "-tzvf", archivePath]);
  assert.equal(tarHeaders.status, 0, tarHeaders.stderr);
  assert.doesNotMatch(tarHeaders.stdout, /marcin|users|staff/u, "tar headers expose build user/group names");
  for (const header of tarHeaders.stdout.trim().split("\n").filter(Boolean)) {
    assert.match(header, /\s0\/0\s/, `tar header is not owned by numeric root: ${header}`);
    assert.match(header, /1970-01-01/, `tar header mtime is not normalized: ${header}`);
  }

  const extract = run("tar", ["-xzf", archivePath, "-C", extractRoot]);
  assert.equal(extract.status, 0, extract.stderr);
  const releaseRoot = join(extractRoot, releaseName);
  assert.equal(statSync(join(releaseRoot, "install.sh")).mode & 0o111, 0o100, "install.sh is not executable");
  assert.equal(readFileSync(join(releaseRoot, "VERSION"), "utf8"), `${pkg.version}\n`);
  const runtimePackage = JSON.parse(readFileSync(join(releaseRoot, "tool", "package.json"), "utf8"));
  assert.equal(runtimePackage.name, pkg.name);
  assert.equal(runtimePackage.version, pkg.version);
  assert.equal(runtimePackage.type, "module");
  assert.deepEqual(runtimePackage.bin, { kb: "./bin/kb" });
  assert.deepEqual(runtimePackage.engines, { node: ">=26" });
  assert.equal("scripts" in runtimePackage, false, "runtime package.json must not reference omitted scripts");

  const agentsDir = join(home, ".agents");
  const skillsDir = join(home, ".agents", "skills");
  mkdirSync(skillsDir, { recursive: true });
  chmodSync(agentsDir, 0o755);
  chmodSync(skillsDir, 0o751);

  const noHomeEnv = { ...environment };
  delete noHomeEnv.HOME;
  const noHome = run(join(releaseRoot, "install.sh"), [noHomeDestination], { env: noHomeEnv });
  assert.notEqual(noHome.status, 0, "installer accepted missing HOME");
  assert.match(noHome.stderr, /HOME is required/);
  assert.equal(existsSync(noHomeDestination), false, "missing HOME created destination");

  symlinkSync(join(root, "missing-destination-target"), danglingDestination);
  assert.equal(existsSync(danglingDestination), false, "dangling destination symlink unexpectedly resolves");
  assert.equal(lstatSync(danglingDestination).isSymbolicLink(), true, "destination fixture is not a symlink");
  const danglingDest = run(join(releaseRoot, "install.sh"), [danglingDestination]);
  assert.notEqual(danglingDest.status, 0, "installer accepted a dangling destination symlink");
  assert.match(danglingDest.stderr, /destination already exists/);
  assert.equal(lstatSync(danglingDestination).isSymbolicLink(), true, "dangling destination symlink was replaced");

  mkdirSync(invalidSkillHome, { mode: 0o700 });
  writeFileSync(join(invalidSkillHome, ".agents"), "not a directory\n", { mode: 0o600 });
  const invalidSkillPath = run(join(releaseRoot, "install.sh"), [invalidSkillDestination], { env: { ...environment, HOME: invalidSkillHome } });
  assert.notEqual(invalidSkillPath.status, 0, "installer accepted a non-directory skill path component");
  assert.match(invalidSkillPath.stderr, /skill path component is not a directory/);
  assert.equal(existsSync(invalidSkillDestination), false, "invalid skill path component created destination before failing");

  mkdirSync(danglingComponentHome, { mode: 0o700 });
  symlinkSync(join(danglingComponentHome, "missing-agents"), join(danglingComponentHome, ".agents"));
  const danglingComponent = run(join(releaseRoot, "install.sh"), [danglingComponentDestination], { env: { ...environment, HOME: danglingComponentHome } });
  assert.notEqual(danglingComponent.status, 0, "installer accepted a dangling skill path component");
  assert.match(danglingComponent.stderr, /skill path component is a dangling symlink/);
  assert.equal(existsSync(danglingComponentDestination), false, "dangling skill path component created destination before failing");

  const extractedFiles = scanExtractedFiles(releaseRoot);
  for (const { rel, fullPath } of extractedFiles) {
    assert.doesNotMatch(rel, forbiddenPath, `forbidden file packaged: ${rel}`);
    const bytes = readFileSync(fullPath);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    assert.doesNotMatch(text, /\/var\/home\/marcin\/vaults|\/var\/home\/marcin\/Repo|\/home\/marcin\/|\/Users\/|[A-Za-z]:\\/u, `machine-specific path packaged in ${rel}`);
  }

  const badSkillTarget = join(badSkillHome, ".agents", "skills", "agent-memory-vault", "SKILL.md");
  mkdirSync(join(badSkillHome, ".agents", "skills", "agent-memory-vault"), { recursive: true });
  writeFileSync(badSkillTarget, readFileSync(join(releaseRoot, "tool", "skills", "agent-memory-vault", "SKILL.md")), { mode: 0o600 });
  chmodSync(badSkillTarget, 0o644);
  const badSkill = run(join(releaseRoot, "install.sh"), [badSkillDestination], { env: { ...environment, HOME: badSkillHome } });
  assert.notEqual(badSkill.status, 0, "installer accepted an existing skill with an unsafe mode");
  assert.match(badSkill.stderr, /skill mode is not 0600/);
  assert.equal(existsSync(badSkillDestination), false, "unsafe existing skill mode created destination before failing");
  const danglingSkillTarget = join(danglingSkillHome, ".agents", "skills", "agent-memory-vault", "SKILL.md");
  mkdirSync(join(danglingSkillHome, ".agents", "skills", "agent-memory-vault"), { recursive: true });
  symlinkSync(join(danglingSkillHome, "missing-skill-target"), danglingSkillTarget);
  assert.equal(existsSync(danglingSkillTarget), false, "dangling skill symlink unexpectedly resolves");
  const danglingSkill = run(join(releaseRoot, "install.sh"), [danglingSkillDestination], { env: { ...environment, HOME: danglingSkillHome } });
  assert.notEqual(danglingSkill.status, 0, "installer accepted a dangling skill symlink");
  assert.match(danglingSkill.stderr, /dangling symlink/);
  assert.equal(existsSync(danglingSkillDestination), false, "dangling skill symlink created destination before failing");

  const install = run(join(releaseRoot, "install.sh"), [destination]);
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const installReport = JSON.parse(install.stdout);
  assert.equal(installReport.ok, true);
  assert.equal(installReport.version, pkg.version);
  assert.equal(installReport.destination, resolve(destination));
  assert.equal(installReport.database, join(resolve(destination), ".agent-kb", "kb.sqlite"));
  assert.equal(installReport.skill, join(home, ".agents", "skills", "agent-memory-vault", "SKILL.md"));

  const status = run(join(destination, "kb"), ["status", "--json"], { cwd: destination });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const statusEnvelope = machine(status);
  assert.equal(statusEnvelope.ok, true);
  assert.equal(statusEnvelope.data.path, join(resolve(destination), ".agent-kb", "kb.sqlite"));
  assert.equal(statusEnvelope.data.schemaVersion, 2);
  assert.match(statusEnvelope.data.authorityDomainId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(statSync(join(destination, ".agent-kb")).mode & 0o777, 0o700);
  assert.equal(statSync(join(destination, ".agent-kb", "kb.sqlite")).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".agents")).mode & 0o777, 0o755, "installer changed pre-existing .agents mode");
  assert.equal(statSync(join(home, ".agents", "skills")).mode & 0o777, 0o751, "installer changed pre-existing skills mode");
  assert.equal(statSync(join(home, ".agents", "skills", "agent-memory-vault")).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, ".agents", "skills", "agent-memory-vault", "SKILL.md")).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(releaseRoot, "tool", "skills", "agent-memory-vault", "SKILL.md")).equals(readFileSync(join(home, ".agents", "skills", "agent-memory-vault", "SKILL.md"))));
  assert.equal(existsSync(join(destination, "INIT.md")), false, "installer did not remove INIT.md after verification");

  mkdirSync(existingDestination, { mode: 0o700 });
  const existing = run(join(releaseRoot, "install.sh"), [existingDestination]);
  assert.notEqual(existing.status, 0, "installer accepted an existing destination");
  assert.match(existing.stderr, /destination already exists/);
  assert.deepEqual(listFiles(existingDestination), [], "existing destination was modified");

  const skillTarget = join(home, ".agents", "skills", "agent-memory-vault", "SKILL.md");
  writeFileSync(skillTarget, "different existing skill\n", { mode: 0o600 });
  const conflict = run(join(releaseRoot, "install.sh"), [conflictDestination]);
  assert.notEqual(conflict.status, 0, "installer overwrote a differing skill");
  assert.match(conflict.stderr, /skill conflict/);
  assert.equal(readFileSync(skillTarget, "utf8"), "different existing skill\n");
  assert.equal(existsSync(conflictDestination), false, "skill conflict created destination before failing");

  assert.equal(existsSync(join(repository, "vault", ".agent-kb")), false, "source template was initialized");
  assert.ok(realHome !== home, "test HOME did not isolate from real HOME");

  report = {
    ok: true,
    archive: archivePath,
    top_level: releaseName,
    files_checked: extractedFiles.length,
    install_destination: destination,
    database: statusEnvelope.data.path,
    skill: skillTarget,
    source_template_touched: false,
    real_home_used: false,
    cleanup: false,
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "release package test cleanup failed");
console.log(JSON.stringify({ ...report, cleanup: true }, null, 2));
