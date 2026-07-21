# agent-KB Pi extension

Registers local typed knowledge-base tools backed by `/var/home/marcin/Repo/agent-kb/src/store.ts` and `node:sqlite`.

Tool names: `kb_search`, `kb_get`, `kb_upsert`, `kb_promote`, `kb_close`, `kb_supersede`, `kb_maintain`, `kb_archive`, `kb_restore`, `kb_purge_candidates`, `kb_status`.

The default database is `~/.local/share/agent-kb/kb.sqlite`; set `AGENT_KB_PATH` to override for tests.

`kb_search` returns compact TOON rows by default. Set `explain: true` only for bounded JSON ranking diagnostics; explain output includes scores and retrieval-list ranks but omits body and evidence. Use `kb_get` for full content.

This repository copy is the extension source, not the installed Pi runtime copy. Pi loads `~/.pi/agent/extensions/agent-kb/index.ts`; changes here, including `explain: true`, require a separately authorized deployment that updates the installed copy and reloads Pi. Verify the installed copy matches `extension/index.ts` after deployment. Repository development and smoke tests do not modify `~/.pi`.

`kb_maintain` is read-only and omits record bodies. `kb_archive` only archives terminal records, and `kb_restore` only transitions records out of `archived` to a type-valid status. Backup and physical prune remain CLI-only safety-gated operations.
