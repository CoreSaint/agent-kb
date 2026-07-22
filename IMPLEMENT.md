# Implement agent-KB v2

## Goal

Create a local typed SQLite knowledge base, agent-agnostic vault template, and portable skill so durable agent knowledge is promote/search based rather than transcript authority.

## Constraints

- Language: TypeScript or plain Node ESM/CJS that runs on Node 26+
- DB: `node:sqlite` (built-in). No better-sqlite3 unless necessary.
- DB path precedence: explicit `AGENT_KB_PATH`; otherwise the nearest physical cwd ancestor containing regular `CONTRACT.md` and `MAP.md` files uses `.agent-kb/kb.sqlite`; otherwise compatibility fallback `~/.local/share/agent-kb/kb.sqlite`
- No embeddings, no repo ingest, no network, no Hindsight API
- Do not commit/push unless asked
- Do not store secrets; reject obvious secret patterns on upsert

## Layout (create)

```text
/var/home/marcin/Repo/agent-kb/
  package.json
  README.md
  src/
    schema.ts       # schema-v2 DDL
    db.ts           # open DB, bootstrap v2, refuse implicit v1 migration
    migration.ts    # explicit v1 preview/apply migration
    types.ts        # record types, statuses
    secrets.ts      # reject heuristics
    store.ts        # CRUD/search/promote/close/supersede
    cli.ts          # kb CLI entry
  bin/kb            # executable shim → node src/cli or built file
  extension/        # optional legacy Pi integration; not portable setup
  skills/agent-memory-vault/SKILL.md
                    # source for ~/.agents/skills/agent-memory-vault/
```

The deployable `vault/` scaffold contains concise human/agent instructions, contract-vault markers, the local `kb` launcher, ignored `.agent-kb/` runtime state, and `.gitkeep` files only for required empty directories. `INIT.md` directs an agent to install `https://github.com/CoreSaint/agent-kb.git` at `.agent-kb/tool/`, install the repository skill at `~/.agents/skills/agent-memory-vault/SKILL.md`, initialize `.agent-kb/kb.sqlite`, verify it, and remove `INIT.md` only after success.

Portable setup is CLI- and filesystem-based. It has no harness APIs, extension dependency, or machine-specific absolute path. The in-folder `AGENTS.md` duplicates the essential workflow as a fallback when global skills are unavailable. The existing `extension/` directory is optional legacy Pi integration and is neither installed nor required by the template.

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
- promoted_from TEXT  -- nullable proposal or explicitly promoted handoff id
- superseded_by TEXT  -- nullable replacement record id
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL
- last_verified_at TEXT  -- nullable
- source TEXT NOT NULL DEFAULT 'user'  -- user|agent_promoted|import|agent

FTS5 virtual table `records_fts` on title, summary, body, project, tags (content sync via triggers).

Table `lineage_migration_ambiguities` durably retains unclassified schema-v1 lineage as `(record_id, target_id, reason)`.

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

Schema version is 2. New databases bootstrap directly at v2. Existing schema-v1 databases are refused during normal open and require explicit `kb migrate` preview followed by `kb migrate --apply`. Preview is read-only. Apply is transactional, classifies only durable → existing proposal/handoff as promotion provenance and record → existing durable as replacement lineage, preserves every other legacy pair in the ambiguity table, updates the schema version last, verifies integrity, and refuses reapplication.

## Write policy in store

- `upsert`: 
  - if type is `handoff` or `proposal`: allow freely
  - if type is durable and record is new: either force type=proposal OR require `allowDurable: true` / CLI `--durable` only when promoting path
  - **Recommended v1:** `upsert` allows handoff + proposal always; durable types only if id already exists with that durable type (update) OR flag `forceDurable` for user CLI; agent tools use promote for new durable
- `promote(id, { type, title?, body?, summary?, project?, tags?, confidence? })`:
  - source record must be a proposal (or a handoff only through the explicit internal option)
  - starts `BEGIN IMMEDIATE`, rejects an existing durable ID or already-promoted proposal, creates the durable record with `promoted_from`, and marks the proposal `promoted` in one transaction
  - rolls back both writes on any error; concurrent attempts yield one success and one conflict
- `close(id, status?)` for handoffs
- `supersede(oldId, newId)` rejects self-reference, sets the old record's lifecycle status and `superseded_by`, and preserves `promoted_from`

## CLI (`kb`)

`kb init` is the only path that creates directories, a database, schema, or authority metadata. All ordinary commands open an existing schema-v2 database and fail closed if it is absent. `kb migrate` requires an existing schema-v1 database. `help`, `version`, `contract`, and `path` do not attach to SQLite.

Vault discovery resolves symlinks to the physical cwd before walking upward. It is read-only. Explicit init may create the discovered vault's `.agent-kb` directory privately, but must not chmod or otherwise mutate the pre-existing vault root.

```text
kb init [--authority-domain UUID] [--json]
kb migrate [--apply] [--json]
kb version [--json]
kb contract [--json]
kb search <query> [--type t] [--status s] [--project p] [--limit n] [--json]
kb get <id> [--json]
kb upsert --input <file|-> [--json]
kb promote <proposalId> --input <file|-> [--json]
kb close <id> [--status closed|archived] [--json]
kb supersede <oldId> <newId> [--json]
kb purge-candidates [--stale-days 14] [--json]
kb status [--json]
kb path [--json]
```

Contract version `1` machine mode is explicitly requested with `--json`. It emits exactly one success or error envelope on stdout, leaves stderr empty, and exits `0` on success, `2` on stable contract errors, or `1` on internal failure. Stable error codes distinguish uninitialized database, authority mismatch, not found, invalid input/command, schema mismatch/migration required, conflict, and internal failure.

Init writes `meta.authority_domain_id`. Public adapters set `AGENT_KB_EXPECTED_DOMAIN`; mismatch or a bound adapter attaching to a legacy unbound database fails closed. Existing in-process callers may open an existing unbound schema-v2 database when no expected domain is configured.

Structured upsert/promote input rejects unknown fields, keeps tags/evidence as JSON arrays, and defaults omitted upsert provenance to `agent`. Legacy interactive flags remain available. Promotion never uses general upsert semantics to replace an existing durable ID.

## Portable skill and optional legacy integration

The source skill is `skills/agent-memory-vault/SKILL.md`. Bootstrap installs it at `~/.agents/skills/agent-memory-vault/SKILL.md` using private user directories. An absent target is copied, a byte-identical target is accepted, and a differing target is a fail-closed conflict that is never overwritten.

The skill uses cwd contract-vault discovery and only the root `./kb` launcher. It covers search/get, handoffs, proposals, deliberate promotion, Markdown authority, secret prohibition, and attachment failures without harness-specific APIs.

The repository's `extension/` directory may remain as optional legacy Pi integration. It is outside the deployable template and portable setup; no installed adapter is modified or required.

## Acceptance checks

Every executable check uses disposable cwd, HOME, and database paths. `scripts/test-cli-contract.mjs` covers the JSON/SQLite contract; `scripts/test-vault-discovery.mjs` covers path precedence and no-create discovery; `scripts/smoke-vault-template.mjs` copies the scaffold, supplies this repository as its local tool without network/global installation, and verifies launcher, init/status, ignore rules, absent/identical/conflicting skill installation, private modes, conflict preservation, and cleanup. A disposable Codex acceptance repeats bootstrap and a handoff → proposal → promote → search/get workflow under a temporary HOME.

```bash
TEST_ROOT="$(mktemp -d)"
chmod 700 "$TEST_ROOT"
export HOME="$TEST_ROOT/home"
export AGENT_KB_PATH="$TEST_ROOT/kb.sqlite"
test "${AGENT_KB_PATH#"$TEST_ROOT"/}" != "$AGENT_KB_PATH"
npm run test:contract
npm run test:vault-discovery
npm run smoke:vault-template
npm run smoke:search
npm run smoke:toon
npm run smoke:maintenance
npm run smoke:eval
npm run smoke:diagnostics
npm run smoke:migration
node --check src/cli.ts
```

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
