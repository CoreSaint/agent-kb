#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.umask(0o077);
const repository = resolve(import.meta.dirname, "..");
const source = join(repository, "vault");
const root = mkdtempSync(join(tmpdir(), "agent-kb-vault-template-"));
const copy = join(root, "vault");
const home = join(root, "home");
const domain = "77777777-7777-4777-8777-777777777777";
const environment = {
  ...process.env,
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
delete environment.AGENT_KB_PATH;
delete environment.AGENT_KB_EXPECTED_DOMAIN;
assert.ok(resolve(home).startsWith(`${resolve(root)}/`));
mkdirSync(home, { mode: 0o700 });

function run(program, args = []) {
  return spawnSync(program, args, { cwd: copy, env: environment, encoding: "utf8" });
}

function installSkill(sourcePath, targetPath) {
  const directories = [
    join(home, ".agents"),
    join(home, ".agents", "skills"),
    join(home, ".agents", "skills", "agent-memory-vault"),
  ];
  for (const directory of directories) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    assert.ok(statSync(directory).isDirectory(), `${directory} is not a directory`);
  }
  if (existsSync(targetPath)) {
    return readFileSync(sourcePath).equals(readFileSync(targetPath)) ? "identical" : "conflict";
  }
  copyFileSync(sourcePath, targetPath);
  chmodSync(targetPath, 0o600);
  return "installed";
}

let report;
try {
  assert.equal(existsSync(join(source, ".agent-kb")), false, "template packages runtime state");
  const packagedFiles = readdirSync(source, { recursive: true, encoding: "utf8" });
  assert.equal(packagedFiles.some((path) => /(?:^|\/)kb\.sqlite(?:-(?:wal|shm))?$/.test(path)), false, "template packages a database binary");

  cpSync(source, copy, { recursive: true });
  chmodSync(copy, 0o750);
  process.chdir(copy);

  const requiredFiles = ["README.md", "INIT.md", "AGENTS.md", "CONTRACT.md", "MAP.md", ".gitignore", "kb"];
  const requiredDirectories = [
    "projects",
    "handoffs",
    "knowledge/decisions",
    "knowledge/procedures",
    "knowledge/research",
    "knowledge/troubleshooting",
    "references",
    "deliverables",
    "inbox",
  ];
  for (const path of requiredFiles) assert.ok(statSync(join(copy, path)).isFile(), `missing template file ${path}`);
  for (const path of requiredDirectories) assert.ok(statSync(join(copy, path)).isDirectory(), `missing template directory ${path}`);
  assert.notEqual(statSync(join(copy, "kb")).mode & 0o111, 0, "root kb launcher is not executable");

  const instructions = readFileSync(join(copy, "INIT.md"), "utf8");
  assert.match(instructions, /Node\.js must be 26 or newer/);
  assert.match(instructions, /https:\/\/github\.com\/CoreSaint\/agent-kb\.git/);
  assert.match(instructions, /\.agent-kb\/tool\/bin\/kb/);
  assert.match(instructions, /\.agent-kb\/kb\.sqlite/);
  assert.match(instructions, /Remove it only after all checks succeed/);
  assert.match(instructions, /\.agents\/skills\/agent-memory-vault\/SKILL\.md/);
  assert.match(instructions, /refusing to overwrite/);
  assert.ok(existsSync(join(repository, "skills", "agent-memory-vault", "SKILL.md")), "source skill is missing");
  assert.match(readFileSync(join(copy, "AGENTS.md"), "utf8"), /If `INIT\.md` exists, process it completely before normal work/);

  const missingTool = run(join(copy, "kb"), ["status", "--json"]);
  assert.equal(missingTool.status, 1);
  assert.match(missingTool.stderr, /process INIT\.md first/);
  assert.equal(existsSync(join(copy, ".agent-kb")), false, "launcher created runtime state without the tool");

  const gitInit = run("git", ["init", "--quiet", "--initial-branch=main"]);
  assert.equal(gitInit.status, 0, gitInit.stderr);
  for (const path of [".agent-kb/kb.sqlite", ".agent-kb/kb.sqlite-wal", ".agent-kb/kb.sqlite-shm", ".agent-kb/tool/bin/kb"]) {
    const ignored = run("git", ["check-ignore", "--quiet", path]);
    assert.equal(ignored.status, 0, `${path} is not ignored`);
  }

  mkdirSync(join(copy, ".agent-kb"), { mode: 0o700 });
  symlinkSync(repository, join(copy, ".agent-kb", "tool"), "dir");
  const version = run(join(copy, "kb"), ["version", "--json"]);
  assert.equal(version.status, 0, version.stderr);
  const versionEnvelope = JSON.parse(version.stdout);
  assert.equal(versionEnvelope.ok, true);
  assert.equal(versionEnvelope.contract_version, "1");

  const skillSource = join(copy, ".agent-kb", "tool", "skills", "agent-memory-vault", "SKILL.md");
  const skillTarget = join(home, ".agents", "skills", "agent-memory-vault", "SKILL.md");
  assert.equal(installSkill(skillSource, skillTarget), "installed");
  for (const directory of [
    join(home, ".agents"),
    join(home, ".agents", "skills"),
    join(home, ".agents", "skills", "agent-memory-vault"),
  ]) assert.equal(statSync(directory).mode & 0o777, 0o700, `${directory} is not private`);
  assert.equal(statSync(skillTarget).mode & 0o777, 0o600, "installed skill is not private");
  assert.ok(readFileSync(skillSource).equals(readFileSync(skillTarget)), "installed skill differs from source");
  assert.doesNotMatch(readFileSync(skillTarget, "utf8"), /(?:\/home\/|\/Users\/|\/var\/home\/|[A-Za-z]:\\)/);

  const identicalMtime = statSync(skillTarget).mtimeMs;
  assert.equal(installSkill(skillSource, skillTarget), "identical");
  assert.equal(statSync(skillTarget).mtimeMs, identicalMtime, "identical skill was overwritten");

  const conflictingSkill = "different existing skill\\n";
  writeFileSync(skillTarget, conflictingSkill, { mode: 0o600 });
  assert.equal(installSkill(skillSource, skillTarget), "conflict");
  assert.equal(readFileSync(skillTarget, "utf8"), conflictingSkill, "conflicting skill was overwritten");
  rmSync(skillTarget);
  assert.equal(installSkill(skillSource, skillTarget), "installed");

  const rootMode = statSync(copy).mode & 0o777;
  const init = run(join(copy, "kb"), ["init", "--authority-domain", domain, "--json"]);
  assert.equal(init.status, 0, init.stdout || init.stderr);
  const initEnvelope = JSON.parse(init.stdout);
  const database = join(copy, ".agent-kb", "kb.sqlite");
  assert.equal(initEnvelope.ok, true);
  assert.equal(initEnvelope.data.path, database);

  const status = run(join(copy, "kb"), ["status", "--json"]);
  assert.equal(status.status, 0, status.stdout || status.stderr);
  const statusEnvelope = JSON.parse(status.stdout);
  assert.equal(statusEnvelope.ok, true);
  assert.equal(statusEnvelope.data.path, database);
  assert.equal(statusEnvelope.data.schemaVersion, 2);
  assert.equal(statusEnvelope.data.authorityDomainId, domain);
  assert.equal(statSync(join(copy, ".agent-kb")).mode & 0o777, 0o700);
  assert.equal(statSync(database).mode & 0o777, 0o600);
  assert.equal(statSync(copy).mode & 0o777, rootMode, "init changed vault root permissions");

  assert.ok(existsSync(join(copy, "INIT.md")), "INIT.md disappeared before verification completed");
  rmSync(join(copy, "INIT.md"));
  assert.equal(existsSync(join(copy, "INIT.md")), false, "successful bootstrap did not remove INIT.md");

  report = {
    ok: true,
    cases: 11,
    template: "vault",
    launcher: "kb",
    database,
    network_used: false,
    global_install_used: false,
  };
} finally {
  process.chdir(tmpdir());
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "template smoke cleanup failed");
console.log(JSON.stringify({ ...report, cleanup: true }, null, 2));
