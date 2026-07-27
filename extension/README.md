# agent-KB Pi extension

Registers local typed knowledge-base tools backed by **this package tree’s** `../src/` modules and `node:sqlite`.

## Import provenance (required)

`index.ts` uses **relative** imports only (`../src/...`). It must never hard-code a host path to a mutable checkout.

| Deploy layout | Effect |
| --- | --- |
| Package root = git archive of commit `SHA` under `~/.local/share/agent-kb/runtimes/<SHA>/` | Extension and CLI execute that commit’s `src/` only |
| Package root = live clone at `/var/home/marcin/Repo/agent-kb` (dev only) | Executes whatever is on disk in that clone — **not** cutover-safe |

Cutover must bind Pi and CLI to a **staged immutable runtime**, not the developer worktree.

**Pi deployment bind (required):** use real private wrappers, never a symlink and never mutable repository source. Stage either a committed runtime or a race-checked worktree snapshot, then generate both bindings:

```sh
RUNTIME_ROOT="$HOME/.local/share/agent-kb/runtimes"
node scripts/stage-immutable-runtime.mjs --worktree-snapshot --root "$RUNTIME_ROOT"
# Use the emitted "dest" value as STAGED_RUNTIME.
node scripts/write-extension-wrapper.mjs \
  --runtime "$STAGED_RUNTIME" \
  --database "$HOME/.local/share/agent-kb/kb.sqlite" \
  --authority-domain <uuid> \
  --cli-dest "$HOME/.local/bin/kb" \
  --extension-dest "$HOME/.pi/agent/extensions/agent-kb/index.ts"
```

The generator validates staged entrypoints and writes a mode-`0700` CLI wrapper and mode-`0600` extension wrapper. Both pin the staged runtime, database path, and expected authority domain before core modules load. It permits an advanced/test environment override only when both `AGENT_KB_PATH` and `AGENT_KB_EXPECTED_DOMAIN` are non-empty; a path-only override retains the installed domain and fails closed for a different database.

## Tools

Typical tools: `kb_search`, `kb_get`, `kb_upsert`, `kb_promote`, `kb_assemble`, `kb_git_preflight_assemble` (when present on the branch), lifecycle/maintain tools, `kb_status`.

Database path: explicit `AGENT_KB_PATH`, otherwise `$HOME/.local/share/agent-kb/kb.sqlite`; core resolution never discovers vaults.

`kb_search` returns compact TOON by default; `explain: true` for bounded ranking diagnostics only.

## Install vs source

This directory is **source**. Pi loads whatever `~/.pi/agent/extensions/agent-kb` points at. Changing this file does nothing until a separately authorized deployment updates that binding and reloads Pi.