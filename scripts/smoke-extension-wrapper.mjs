#!/usr/bin/env node
/**
 * Disposable proof of Pi-style extension discovery:
 * a real wrapper file under extensions/agent-kb re-exports an immutable
 * runtime entry whose package-relative ../src imports resolve.
 *
 * Does not require typebox or live Pi.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "akb-ext-wrap-"));
process.umask(0o077);

function die(msg) {
  console.error(msg);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

try {
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "extension"), { recursive: true, mode: 0o700 });
  mkdirSync(join(runtime, "src"), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtime, "APPROVED_COMMIT"), "deadbeef\n", { mode: 0o600 });
  writeFileSync(
    join(runtime, "src/marker.ts"),
    'export const MARKER = "immutable-src";\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(runtime, "extension/index.ts"),
    `import { MARKER } from "../src/marker.ts";
export default function extension() { return { marker: MARKER }; }
`,
    { mode: 0o600 },
  );

  const wrapScript = join(dirname(fileURLToPath(import.meta.url)), "write-extension-wrapper.mjs");
  const extensions = join(root, "extensions/agent-kb");
  mkdirSync(extensions, { recursive: true, mode: 0o700 });
  const wrapper = join(extensions, "index.ts");

  // Negative: directory symlink bind fails module-relative resolution under discovery path.
  const symlinkDir = join(root, "extensions-symlink");
  mkdirSync(symlinkDir, { recursive: true, mode: 0o700 });
  const link = join(symlinkDir, "agent-kb");
  spawnSync("ln", ["-sfn", join(runtime, "extension"), link], { encoding: "utf8" });
  const neg = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(pathToFileURL(join(link, "index.ts")).href)}).then(m=>console.log(m.default())).catch(e=>{console.error(e.message); process.exit(2)})`,
    ],
    { encoding: "utf8" },
  );
  // On some Node versions symlink+realpath works; we only require wrapper path to work.
  // If symlink fails, that documents the Pi-class failure mode.
  const symlinkOk = neg.status === 0;

  const r = spawnSync(
    process.execPath,
    [wrapScript, "--runtime", runtime, "--dest", wrapper, "--force"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) die(`write-extension-wrapper failed:\n${r.stderr || r.stdout}`);

  const body = readFileSync(wrapper, "utf8");
  if (!body.includes(join(runtime, "extension/index.ts"))) {
    die(`wrapper does not pin absolute runtime entry:\n${body}`);
  }

  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(wrapper).href)});
const v = m.default();
if (v.marker !== "immutable-src") throw new Error("wrong marker: " + JSON.stringify(v));
console.log(JSON.stringify({ ok: true, marker: v.marker }));`,
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) die(`wrapper load failed:\n${probe.stderr || probe.stdout}`);

  console.log(JSON.stringify({
    ok: true,
    wrapper,
    wrapper_sha256: createHash("sha256").update(body).digest("hex"),
    wrapper_body: body.trim(),
    probe: JSON.parse(probe.stdout.trim()),
    directory_symlink_load_ok: symlinkOk,
    note: symlinkOk
      ? "directory symlink happened to work on this Node; Pi still requires real-file wrapper"
      : "directory symlink failed as expected under non-realpath resolution",
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
