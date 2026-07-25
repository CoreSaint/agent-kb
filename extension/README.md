# agent-KB Pi extension

Registers local typed knowledge-base tools backed by **this package tree’s** `../src/` modules and `node:sqlite`.

## Import provenance (required)

`index.ts` uses **relative** imports only (`../src/...`). It must never hard-code a host path to a mutable checkout.

| Deploy layout | Effect |
| --- | --- |
| Package root = git archive of commit `SHA` under `~/.local/share/agent-kb/runtimes/<SHA>/` | Extension and CLI execute that commit’s `src/` only |
| Package root = live clone at `/var/home/marcin/Repo/agent-kb` (dev only) | Executes whatever is on disk in that clone — **not** cutover-safe |

Cutover must bind Pi and CLI to a **staged immutable runtime**, not the developer worktree.

**Pi discovery bind (required):** do **not** symlink `~/.pi/agent/extensions/agent-kb` to `<runtime>/extension`. Pi resolves relative imports from the discovery path, so that layout looks for `~/.pi/agent/extensions/src` and fails. Use a **real file wrapper** that re-exports the absolute runtime entry (proven on the 2026-07-25 cutover rollback):

```text
~/.local/share/agent-kb/runtimes/<approved-sha>/   # git archive of approved commit
  bin/kb
  extension/index.ts   # relative imports → ../src  (resolved from this real path)
  src/...

~/.pi/agent/extensions/agent-kb/index.ts   # REAL file (mode 0600), not a symlink dir:
  export { default } from "/…/runtimes/<sha>/extension/index.ts";

~/.local/bin/kb  →  symlink to .../runtimes/<sha>/bin/kb
```

Stage + bind:

```bash
node scripts/stage-immutable-runtime.mjs --commit <full-sha> --label v3-approved
node scripts/stage-immutable-runtime.mjs --commit <rollback-sha> --label v2-rollback
# separately authorized:
#   rm any symlink at ~/.pi/agent/extensions/agent-kb if present; use a real directory
#   node scripts/write-extension-wrapper.mjs --runtime <v3-runtime> --force
#   ln -sfn <v3-runtime>/bin/kb ~/.local/bin/kb
# disposable proof:
#   npm run smoke:extension-wrapper
```

## Tools

Typical tools: `kb_search`, `kb_get`, `kb_upsert`, `kb_promote`, `kb_assemble`, `kb_git_preflight_assemble` (when present on the branch), lifecycle/maintain tools, `kb_status`.

Database path: vault discovery / `AGENT_KB_PATH` / compatibility fallback per core CLI.

`kb_search` returns compact TOON by default; `explain: true` for bounded ranking diagnostics only.

## Install vs source

This directory is **source**. Pi loads whatever `~/.pi/agent/extensions/agent-kb` points at. Changing this file does nothing until a separately authorized deployment updates that binding and reloads Pi.