#!/usr/bin/env node
/**
 * Write a Pi-discovered extension entry that re-exports an immutable runtime
 * extension by absolute path.
 *
 * Pi resolves static relative imports from the *installed* discovery path. A
 * symlink of ~/.pi/agent/extensions/agent-kb -> <runtime>/extension therefore
 * breaks "../src/*". A real file that only re-exports the runtime entry is
 * loaded such that the runtime module's own URL is the absolute runtime path,
 * so package-relative imports work and provenance stays on the staged tree.
 *
 * Does not touch databases or start Pi.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

function die(msg) {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { runtime: null, dest: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runtime") out.runtime = argv[++i];
    else if (a === "--dest") out.dest = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/write-extension-wrapper.mjs --runtime <staged-runtime-root> [--dest path] [--force]
Default dest: ~/.pi/agent/extensions/agent-kb/index.ts
Writes a private real file (not a symlink) re-exporting <runtime>/extension/index.ts.`);
      process.exit(0);
    } else die(`Unknown argument: ${a}`);
  }
  if (!out.runtime) die("--runtime is required");
  return out;
}

function main() {
  process.umask(0o077);
  const args = parseArgs(process.argv.slice(2));
  const runtime = realpathSync(resolve(args.runtime));
  const entry = join(runtime, "extension/index.ts");
  if (!existsSync(entry)) die(`Missing runtime extension entry: ${entry}`);
  if (!existsSync(join(runtime, "src"))) die(`Missing runtime src/: ${runtime}`);
  // Fail closed if entry still points at a mutable host checkout path.
  const entryText = readFileSync(entry, "utf8");
  if (/from\s+["']\/var\/home\/marcin\/Repo\/agent-kb\//.test(entryText)) {
    die(`Runtime extension still has absolute mutable imports: ${entry}`);
  }

  const dest = resolve(
    args.dest || join(process.env.HOME || die("HOME required"), ".pi/agent/extensions/agent-kb/index.ts"),
  );
  const destDir = dirname(dest);
  if (existsSync(dest) && !args.force) die(`Destination exists (pass --force to replace): ${dest}`);
  if (existsSync(destDir)) {
    const st = lstatSync(destDir);
    if (st.isSymbolicLink()) {
      die(`Destination directory is a symlink; remove it and use a real directory: ${destDir}`);
    }
  } else {
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
  }

  // Absolute path in the re-export is intentional: it pins discovery to the
  // staged runtime object. Relative discovery paths are what broke under Pi.
  const body = `export { default } from ${JSON.stringify(entry)};\n`;
  writeFileSync(dest, body, { mode: 0o600 });
  chmodSync(dest, 0o600);

  const report = {
    ok: true,
    runtime,
    runtime_entry: entry,
    wrapper: dest,
    wrapper_sha256: createHash("sha256").update(body).digest("hex"),
    approved_commit_file: existsSync(join(runtime, "APPROVED_COMMIT"))
      ? readFileSync(join(runtime, "APPROVED_COMMIT"), "utf8").trim()
      : null,
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
