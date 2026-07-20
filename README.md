# agent-KB

Local typed SQLite knowledge base for Pi agent handoffs, proposals, and promoted durable knowledge.

## CLI

```sh
export AGENT_KB_PATH=/tmp/agent-kb.sqlite # optional
./bin/kb init
./bin/kb upsert --id handoff:demo --type handoff --title "Demo" --summary "Open handoff"
./bin/kb search demo --type handoff
./bin/kb promote proposal:demo --type decision --id decision:demo
```

Default database path is `~/.local/share/agent-kb/kb.sqlite`; `AGENT_KB_PATH` overrides it.

- `kb search` defaults to **TOON** compact hits (id, type, status, project, confidence, title, summary) for token-efficient LLM/tool output. Pass `--json` for full records.
- Other commands still print JSON by default.

## Search

`kb search` uses hybrid lexical retrieval over FTS5: exact id, phrase, AND, title/tags, and OR candidate lists are fused with Reciprocal Rank Fusion, then lightly reranked by status, type, confidence, and type-aware freshness (no embeddings, no LLM). Empty queries list by `updated_at` under the same filters. Promoted/deprecated/superseded records are demoted unless an explicit status filter requests them.

Search hit rendering uses a minimal TOON tabular encoding (schema once, then rows). Full body/evidence still come from `kb get` / `kb_get`.

## Maintenance

Maintenance commands return metadata and IDs, not record bodies:

```sh
./bin/kb maintain --stale-days 14
./bin/kb archive handoff:completed
./bin/kb restore handoff:completed --status closed
./bin/kb verify decision:reviewed --date 2026-07-20
./bin/kb backup --output /private/path/kb-backup.sqlite
./bin/kb prune
./bin/kb prune --apply --backup /private/path/kb-backup.sqlite
```

- `maintain` is read-only. It categorizes stale open/blocked handoffs; promoted proposals and their durable-target linkage count; rejected proposals; closed/archived handoffs; inactive durable records; and active/done durable records without `last_verified_at`. It also reports the database path, main-file size, and `PRAGMA quick_check`.
- `archive` is reversible and intentionally narrow. It accepts closed handoffs; promoted/rejected proposals; superseded decisions; deprecated procedures, landscapes, and preferences; and done/deprecated troubleshoot records. It refuses open/blocked records, drafts, active durable records, and records already archived.
- `restore` only accepts archived records and validates the requested status against the record type.
- `verify` accepts an exact, valid `YYYY-MM-DD` calendar date. It changes only `last_verified_at` and `updated_at`; verification must follow an explicit evidence review.
- `backup` uses Node's built-in consistent SQLite backup operation, refuses an existing output, creates mode `0600`, records a maintenance validation marker, and removes a newly created output if its integrity check fails. Without `--output`, it generates a timestamped path beside the database.

`prune` is always a dry-run unless `--apply` is present. The default allowlist is:

| Category | Minimum retention |
| --- | ---: |
| Promoted proposal linked to exactly one durable target | 30 days since promotion/update |
| Archived proposal linked to exactly one durable promotion target | 30 days since archival/update |
| Rejected proposal | 90 days |
| Archived handoff | 90 days |

Open, blocked, active, fresh, unlinked, multiply linked, and durable records are never selected automatically. Archival alone never makes an arbitrary proposal eligible: an archived proposal still needs exactly one durable record linked through the promotion relationship, and `archive` resets its 30-day retention clock through `updated_at`. Apply mode requires `--backup` naming a private, valid backup created by `kb backup` for the same database within the last 15 minutes. The backup must still match current record metadata, so create it after all intended lifecycle changes and immediately before applying. Deletion runs in one transaction; foreign-key, FTS-trigger behavior, and `quick_check` are verified by the maintenance smoke script.

Run all checks only against disposable databases:

```sh
AGENT_KB_PATH=/tmp/agent-kb-smoke.sqlite npm run smoke
AGENT_KB_PATH=/tmp/agent-kb-search.sqlite npm run smoke:search
AGENT_KB_PATH=/tmp/agent-kb-toon.sqlite npm run smoke:toon
npm run smoke:maintenance
```
