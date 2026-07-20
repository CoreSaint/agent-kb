# agent-KB Pi extension

Registers local typed knowledge-base tools backed by `/var/home/marcin/Repo/agent-kb/src/store.ts` and `node:sqlite`.

Tool names: `kb_search`, `kb_get`, `kb_upsert`, `kb_promote`, `kb_close`, `kb_supersede`, `kb_purge_candidates`, `kb_status`.

The default database is `~/.local/share/agent-kb/kb.sqlite`; set `AGENT_KB_PATH` to override for tests.
