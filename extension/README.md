# agent-KB Pi extension

Registers local typed knowledge-base tools backed by `/var/home/marcin/Repo/agent-kb/src/store.ts` and `node:sqlite`.

Tool names: `kb_search`, `kb_get`, `kb_upsert`, `kb_promote`, `kb_close`, `kb_supersede`, `kb_maintain`, `kb_archive`, `kb_restore`, `kb_purge_candidates`, `kb_status`.

The default database is `~/.local/share/agent-kb/kb.sqlite`; set `AGENT_KB_PATH` to override for tests.

`kb_maintain` is read-only and omits record bodies. `kb_archive` only archives terminal records, and `kb_restore` only transitions records out of `archived` to a type-valid status. Backup and physical prune remain CLI-only safety-gated operations.
