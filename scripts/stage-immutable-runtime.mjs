#!/usr/bin/env node
/**
 * Materialize a self-contained agent-KB runtime from a local git commit object.
 * The staged tree is the unit of provenance for CLI + Pi extension (relative imports).
 *
 * Does not modify live Pi bindings, the live DB, or the developer worktree checkout.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function die(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { commit: null, label: null, root: null, repo: repoRoot };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commit") out.commit = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/stage-immutable-runtime.mjs --commit <full-sha> [--label name] [--root dir] [--repo path]
Default root: ~/.local/share/agent-kb/runtimes/<commit>
Writes APPROVED_COMMIT, MANIFEST.sha256, and rewrites legacy absolute extension imports if present.`);
      process.exit(0);
    } else die(`Unknown argument: ${a}`);
  }
  if (!out.commit || !/^[0-9a-f]{40}$/i.test(out.commit)) die("--commit must be a full 40-char git SHA");
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    die(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, base, acc);
    else if (st.isFile()) acc.push(p.slice(base.length + 1));
  }
  return acc;
}

function rewriteAbsoluteExtensionImports(extensionPath) {
  if (!existsSync(extensionPath)) return false;
  const before = readFileSync(extensionPath, "utf8");
  // Map any absolute host imports of this package's src/ to relative ../src/
  const after = before.replace(
    /from\s+["']\/[^"']*\/agent-kb\/src\/([^"']+)["']/g,
    'from "../src/$1"',
  ).replace(
    /from\s+["']\/var\/home\/marcin\/Repo\/agent-kb\/src\/([^"']+)["']/g,
    'from "../src/$1"',
  );
  if (after !== before) {
    writeFileSync(extensionPath, after, { mode: 0o600 });
    return true;
  }
  return false;
}

function assertNoAbsoluteAgentKbSrcImports(root) {
  const offenders = [];
  for (const rel of walkFiles(root)) {
    if (!rel.endsWith(".ts") && !rel.endsWith(".mjs") && !rel.endsWith(".js")) continue;
    const text = readFileSync(join(root, rel), "utf8");
    if (/from\s+["']\/var\/home\/marcin\/Repo\/agent-kb\//.test(text)) offenders.push(rel);
    if (/from\s+["']\/[^"']*\/agent-kb\/src\//.test(text)) offenders.push(rel);
  }
  if (offenders.length) {
    die(`Absolute agent-kb src imports remain in staged runtime:\n${offenders.join("\n")}`);
  }
}

async function main() {
  process.umask(0o077);
  const args = parseArgs(process.argv.slice(2));
  const repo = realpathSync(args.repo);
  const commit = run("git", ["-C", repo, "rev-parse", `${args.commit}^{commit}`]);
  if (commit.toLowerCase() !== args.commit.toLowerCase()) {
    die(`rev-parse mismatch: got ${commit}, expected ${args.commit}`);
  }
  // Ensure object is local (no network).
  run("git", ["-C", repo, "cat-file", "-e", `${commit}^{commit}`]);

  const defaultRoot = join(
    process.env.HOME || die("HOME required"),
    ".local/share/agent-kb/runtimes",
    args.label ? `${args.label}-${commit}` : commit,
  );
  const dest = resolve(args.root || defaultRoot);
  if (existsSync(dest)) die(`Destination already exists: ${dest}`);

  mkdirSync(dest, { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);

  const archive = spawnSync("git", ["-C", repo, "archive", "--format=tar", commit], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) die(`git archive failed: ${archive.stderr?.toString() || ""}`);

  const tar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout, encoding: "buffer" });
  if (tar.status !== 0) die(`tar extract failed: ${tar.stderr?.toString() || ""}`);

  writeFileSync(join(dest, "APPROVED_COMMIT"), `${commit}\n`, { mode: 0o600 });
  if (args.label) writeFileSync(join(dest, "RUNTIME_LABEL"), `${args.label}\n`, { mode: 0o600 });

  const ext = join(dest, "extension/index.ts");
  const rewritten = rewriteAbsoluteExtensionImports(ext);
  assertNoAbsoluteAgentKbSrcImports(dest);

  // Syntax check entrypoints when present.
  for (const rel of ["src/cli.ts", "extension/index.ts"]) {
    const p = join(dest, rel);
    if (!existsSync(p)) continue;
    const chk = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    if (chk.status !== 0) die(`node --check ${rel} failed:\n${chk.stderr}`);
  }

  const files = walkFiles(dest).sort();
  const lines = files.map((rel) => `${sha256File(join(dest, rel))}  ${rel}`);
  const manifestBody = `${lines.join("\n")}\n`;
  writeFileSync(join(dest, "MANIFEST.sha256"), manifestBody, { mode: 0o600 });
  const manifestHash = createHash("sha256").update(manifestBody).digest("hex");

  const report = {
    ok: true,
    commit,
    dest,
    label: args.label || null,
    extension_absolute_imports_rewritten: rewritten,
    manifest_sha256: manifestHash,
    file_count: files.length,
    bind_extension_example: `ln -sfn ${join(dest, "extension")} "\${HOME}/.pi/agent/extensions/agent-kb"`,
    bind_cli_example: `ln -sfn ${join(dest, "bin/kb")} "\${HOME}/.local/bin/kb"`,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => die(err instanceof Error ? err.stack || err.message : String(err)));
