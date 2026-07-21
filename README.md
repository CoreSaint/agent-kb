# agent-KB

Local typed SQLite knowledge base for Pi agent handoffs, proposals, and promoted durable knowledge.

## Memory architecture and authority

agent-KB is authoritative for curated agent continuity within its scope, including promoted typed records. It never overrides canonical vault policy or human-facing documentation, repository code and repository-local documentation, or live external-system state in their respective domains. Agents should inspect those canonical sources directly before acting when current truth matters; a KB hit provides durable agent knowledge and continuity within its scope, not a replacement for domain authority outside it.

Records have a type-specific lifecycle:

- Agents capture uncertain durable knowledge as an open `proposal`. Explicit promotion creates an active durable `decision`, `procedure`, `troubleshoot`, `landscape`, or `preference`, then marks the proposal `promoted`.
- `handoff` records carry bounded work-in-progress continuity and move from `open` or `blocked` to `closed`, then may be archived.
- Durable records remain active until explicitly superseded, deprecated, or archived. Maintenance reports lifecycle candidates but does not silently promote or rewrite knowledge.

Schema v1 uses `supersedes` for both a durable record's proposal source and an old durable record's replacement. That overloaded lineage is a known limitation deferred to A3. Search metadata reranking is not calibrated against the lexical score range; correcting and diagnosing that behavior is deferred to A2.

Session JSONL is an execution transcript, not a durable knowledge source and not an ingestion feed. Pi observational memory may summarize context for continuity within a session and across compaction, but it does not promote records, replace handoffs, or become authoritative agent-KB content.

Explicit non-goals:

- no whole-repository memory or repository indexing;
- no automatic transcript or observational-memory promotion;
- no Hindsight capture or mutation;
- no embeddings, vector retrieval, or active recall yet.

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

## Retrieval evaluation

`npm run smoke:eval` loads `scripts/fixtures/search-eval.json`, creates a new database under the operating-system temporary directory, evaluates the public `KbStore.search` method, closes the database, and removes the directory. Fixtures are synthetic and non-sensitive. Cases declare expected and forbidden IDs, optional type/status/project filters, exact-rank expectations, and within-top-N expectations.

The command emits one JSON report and exits non-zero if any case expectation fails. Aggregate formulas are:

- `recall_at_K`: expected IDs found in the first $K$ results, divided by all expected IDs; expected-miss cases contribute no denominator.
- `mean_reciprocal_rank`: mean of $1/r$ for the first expected hit in each case that has expected IDs; a miss contributes zero.
- `forbidden_hit_failures`: number of cases where at least one forbidden ID occurs in the returned result set.
- `elapsed_ms`: wall-clock time spent executing and checking all search cases, excluding fixture seeding.

`npm run smoke:eval -- --inject-failure` replaces one expectation in memory with an impossible ID. It is the negative self-test for the non-zero exit contract and does not modify the fixture.

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
npm run smoke:eval
```
