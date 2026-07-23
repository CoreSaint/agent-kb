#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

process.umask(0o077);

const repository = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
assert.equal(typeof pkg.name, "string", "package.json name must be a string");
assert.equal(typeof pkg.version, "string", "package.json version must be a string");

const host = `${process.platform}-${process.arch}`;
const releaseName = `${pkg.name}-${pkg.version}-${host}`;
const outputRoot = join(repository, "release");
const stagingRoot = mkdtempSync(join(tmpdir(), "agent-kb-release-staging-"));
const releaseRoot = join(stagingRoot, releaseName);
const archivePath = join(outputRoot, `${releaseName}.tar.gz`);
const temporaryArchivePath = join(outputRoot, `.${releaseName}.${process.pid}.tmp.tar.gz`);

const forbiddenNames = new Set([".git", "node_modules", "release", "dist", "build", ".tmp", ".coverage"]);
const forbiddenSuffixes = [/\.sqlite(?:-(?:wal|shm))?$/u, /\.log$/u];

function assertInsideRepository(path) {
  const resolved = resolve(path);
  assert.ok(resolved === repository || resolved.startsWith(`${repository}/`), `path escaped repository: ${path}`);
}

function copyFiltered(source, target) {
  assertInsideRepository(source);
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    filter: (from) => {
      const name = basename(from);
      const rel = relative(repository, from);
      if (rel === "") return true;
      if (forbiddenNames.has(name)) return false;
      if (rel.split("/").includes(".agent-kb")) return false;
      if (forbiddenSuffixes.some((pattern) => pattern.test(name))) return false;
      return true;
    },
  });
}

function writeRuntimePackageJson(target) {
  const runtimePackage = {
    name: pkg.name,
    version: pkg.version,
    type: pkg.type ?? "module",
    bin: pkg.bin ?? { kb: "./bin/kb" },
    engines: pkg.engines ?? { node: ">=26" },
  };
  writeFileSync(target, `${JSON.stringify(runtimePackage, null, 2)}\n`, { mode: 0o600 });
}

try {
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  rmSync(temporaryArchivePath, { force: true });
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });

  copyFiltered(join(repository, "vault"), join(releaseRoot, "vault"));
  mkdirSync(join(releaseRoot, "tool"), { mode: 0o700 });
  writeRuntimePackageJson(join(releaseRoot, "tool", "package.json"));
  for (const entry of ["README.md", "INSTALL.md", "AGENTS.md", "bin", "src", "skills"]) {
    copyFiltered(join(repository, entry), join(releaseRoot, "tool", entry));
  }
  cpSync(join(repository, "scripts", "release-install.sh"), join(releaseRoot, "install.sh"));
  chmodSync(join(releaseRoot, "install.sh"), 0o700);
  chmodSync(join(releaseRoot, "tool", "bin", "kb"), 0o700);
  chmodSync(join(releaseRoot, "vault", "kb"), 0o700);
  writeFileSync(join(releaseRoot, "VERSION"), `${pkg.version}\n`, { mode: 0o600 });

  const tar = spawnSync("tar", [
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mtime=@0",
    "-czf",
    temporaryArchivePath,
    "-C",
    stagingRoot,
    releaseName,
  ], {
    cwd: repository,
    encoding: "utf8",
  });
  if (tar.status !== 0) {
    throw new Error(`tar failed (${tar.status}): ${tar.stderr || tar.stdout || tar.error?.message || "unknown error"}`);
  }
  renameSync(temporaryArchivePath, archivePath);

  const archiveMode = statSync(archivePath).mode & 0o777;
  console.log(JSON.stringify({ ok: true, archive: archivePath, name: `${releaseName}.tar.gz`, version: pkg.version, host, mode: archiveMode.toString(8), owner: "0", group: "0", mtime: "@0" }, null, 2));
} finally {
  rmSync(temporaryArchivePath, { force: true });
  rmSync(stagingRoot, { recursive: true, force: true });
}
