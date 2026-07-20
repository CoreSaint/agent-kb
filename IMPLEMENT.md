# Implement agent-KB v1

## Goal

Create a local typed SQLite knowledge base with CLI and a Pi coding-agent extension so durable agent knowledge is promote/search based, not Hindsight/chat authority.

## Constraints

- Language: TypeScript or plain Node ESM/CJS that runs on Node 26+
- DB: `node:sqlite` (built-in). No better-sqlite3 unless necessary.
- Default DB path: `~/.local/share/agent-kb/kb.sqlite` (env `AGENT_KB_PATH` overrides)
- No embeddings, no repo ingest, no network, no Hindsight API
- Do not commit/push unless asked
- Do not store secrets; reject obvious secret patterns on upsert
- Do not disable existing Hindsight extension

## Layout (create)

```text
/var/home/marcin/Repo/agent-kb/
  package.json
  README.md
  src/
    schema.ts       # DDL + migrations
    db.ts           # open DB, ensure schema
    types.ts        # record types, statuses
    secrets.ts      # reject heuristics
    store.ts        # CRUD/search/promote/close/supersede
    cli.ts          # kb CLI entry
  bin/kb            # executable shim → node src/cli or built file
  extension/        # Pi extension (copy or symlink target: ~/.pi/agent/extensions/agent-kb/)
    index.ts
    README.md
```

Also create/update:

- `~/.pi/agent/skills/kb-recall/SKILL.md`
- Update `~/.pi/agent/skills/knowledge-capture/SKILL.md` to prefer agent-KB promote; vault optional; no default Hindsight pointer

Prefer implementing the core library so both CLI and extension import the same store (extension can spawn `kb` CLI if in-process import is awkward—**prefer in-process import of store**).

## Schema

Table `records`:

- id TEXT PRIMARY KEY
- type TEXT NOT NULL  -- handoff|decision|procedure|troubleshoot|landscape|preference|proposal
- title TEXT NOT NULL
- status TEXT NOT NULL
- project TEXT
- tags TEXT NOT NULL DEFAULT '[]'  -- JSON array
- body TEXT NOT NULL DEFAULT ''
- summary TEXT NOT NULL DEFAULT ''
- confidence TEXT NOT NULL DEFAULT 'medium'  -- high|medium|low
- evidence TEXT NOT NULL DEFAULT '[]'  -- JSON array of strings
- supersedes TEXT  -- id
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL
- last_verified_at TEXT  -- nullable
- source TEXT NOT NULL DEFAULT 'user'  -- user|agent_promoted|import|agent

FTS5 virtual table `records_fts` on title, summary, body, project, tags (content sync via triggers).

Indexes: type, status, project, updated_at.

## Status rules

| type | allowed statuses |
|---|---|
| handoff | open, blocked, closed, archived |
| decision | draft, active, superseded, archived |
| procedure | draft, active, deprecated, archived |
| troubleshoot | draft, active, done, deprecated, archived |
| landscape | draft, active, deprecated, archived |
| preference | draft, active, deprecated, archived |
| proposal | open, rejected, promoted, archived |

Defaults: handoff→open, proposal→open, others→draft on create unless specified; promote sets durable type status to `active` (troubleshoot may be `done` if requested).

## Write policy in store

- `upsert`: 
  - if type is `handoff` or `proposal`: allow freely
  - if type is durable and record is new: either force type=proposal OR require `allowDurable: true` / CLI `--durable` only when promoting path
  - **Recommended v1:** `upsert` allows handoff + proposal always; durable types only if id already exists with that durable type (update) OR flag `forceDurable` for user CLI; agent tools use promote for new durable
- `promote(id, { type, title?, body?, summary?, project?, tags?, confidence? })`:
  - source record should be proposal (or allow promote-from-handoff findings only if explicit)
  - creates/updates durable record; mark proposal status `promoted`; set source `agent_promoted` or keep user; set last_verified_at now optional
- `close(id, status?)` for handoffs
- `supersede(oldId, newId)` set old status superseded and link

## CLI (`kb`)

```text
kb init
kb search <query> [--type t] [--status s] [--project p] [--limit n]
kb get <id>
kb upsert --id --type --title [--status] [--project] [--tags a,b] [--summary] [--body-file f] [--body] [--confidence] [--evidence e1,e2] [--source]
kb promote <proposalId> --type decision|... [--id newId] [--title] ...
kb close <id> [--status closed|archived]
kb supersede <oldId> <newId>
kb purge-candidates [--stale-days 14]
kb path   # print db path
```

Exit non-zero on validation errors. Print JSON for machine use (`--json` flag default true for tools) and optional human table.

## Pi extension tools

Register tools (names):

- `kb_search`
- `kb_get`
- `kb_upsert`
- `kb_promote`
- `kb_close`
- `kb_supersede`
- `kb_purge_candidates`
- `kb_status` (db path, counts by type/status)

Mirror hindsight extension style in `~/.pi/agent/extensions/hindsight/index.ts` for ExtensionAPI patterns.

Install extension by writing to `~/.pi/agent/extensions/agent-kb/index.ts` (can re-export from repo or be the real file). Prefer **repo as source of truth** and copy/symlink into `~/.pi/agent/extensions/agent-kb`.

## Skill: kb-recall

Path: `~/.pi/agent/skills/kb-recall/SKILL.md`

- When to use
- Retrieval order: open handoffs → troubleshoot → procedure → decision → landscape → preference
- Always cite record ids
- Label possibly stale if last_verified_at old / null on procedures & landscapes
- Code questions: use repo tools, not KB as code authority
- Hindsight only if user asks or KB miss (transition)

## knowledge-capture skill update

- Inside capture flow: prefer `kb_upsert` proposal + `kb_promote` for durable
- Vault: optional human-facing Markdown when user wants or contract vault explicitly requested
- Do not default Hindsight pointer retains
- Point at transition procedure path in personal vault

## Acceptance checks (must pass)

```bash
export AGENT_KB_PATH=/tmp/agent-kb-smoke.sqlite
rm -f "$AGENT_KB_PATH"
node ... kb init   # or ./bin/kb init
# upsert handoff
# search finds it
# upsert proposal + promote to decision
# get decision
# close handoff
# purge-candidates runs
```

Also verify extension file exists and parses (tsc or node import).

## Out of scope

- Migrating hermes data
- Disabling hindsight extension
- Embeddings
- Git commit

## Report back

- Files created
- How to run CLI
- Smoke test output
- Any deviations from this handoff
