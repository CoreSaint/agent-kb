# Implement agent-KB

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
    schema.ts       # schema-v3 DDL
    db.ts           # open DB, bootstrap v3, refuse implicit migration
    migration.ts    # explicit v1→v2 and v2→v3 preview/apply migrations
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

Portable setup is CLI- and filesystem-based. It has no harness APIs, extension dependency, or machine-specific absolute path. The in-folder `CONTRACT.md` is the complete behavioral fallback when global skills are unavailable; `AGENTS.md` is a thin host/harness adapter and does not duplicate policy. The existing `extension/` directory is optional legacy Pi integration and is neither installed nor required by the template.

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
- evidence TEXT NOT NULL DEFAULT '[]'  -- JSON array of snapshot|live|pointer objects
- assertion_basis TEXT  -- nullable legacy-unknown, otherwise asserted|inferred
- as_of TEXT  -- nullable RFC 3339 UTC timestamp
- expires_at TEXT  -- nullable RFC 3339 UTC timestamp, constrained at the boundary to >= as_of
- canonical_ids TEXT NOT NULL DEFAULT '[]'  -- JSON array of required authority identifiers
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

Schema version is 3. New databases bootstrap directly at v3. Existing schema-v1 and schema-v2 databases are refused during normal open and require explicit `kb migrate` preview followed by `kb migrate --apply` for each version step. Preview is read-only. V1→v2 retains the lineage classification contract. V2→v3 transactionally adds Slice-1 fields, wraps each legacy evidence string as a weak pointer without fabricating time or hash, preserves FTS/lineage/authority metadata, updates the schema version last among mutations, verifies integrity, and refuses reapplication.

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

`kb init` is the only path that creates directories, a database, schema, or authority metadata. All ordinary commands open an existing schema-v3 database and fail closed if it is absent or needs migration. `kb migrate` requires an existing schema-v1 or schema-v2 database. `help`, `version`, `contract`, and `path` do not attach to SQLite.

Vault discovery resolves symlinks to the physical cwd before walking upward. It is read-only. Explicit init may create the discovered vault's `.agent-kb` directory privately, but must not chmod or otherwise mutate the pre-existing vault root.

```text
kb init [--authority-domain UUID] [--json]
kb migrate [--apply] [--json]
kb version [--json]
kb contract [--json]
kb search <query> [--type t] [--status s] [--project p] [--limit n] [--json]
kb get <id> [--json]
kb upsert --input <file|-> [--json]
kb assemble --input <file|-> [--json]
kb promote <proposalId> --input <file|-> [--json]
kb close <id> [--status closed|archived] [--json]
kb supersede <oldId> <newId> [--json]
kb purge-candidates [--stale-days 14] [--json]
kb status [--json]
kb path [--json]
```

Contract version `1` machine mode is explicitly requested with `--json`. It emits exactly one success or error envelope on stdout, leaves stderr empty, and exits `0` on success, `2` on stable contract errors, or `1` on internal failure. Stable error codes distinguish uninitialized database, authority mismatch, not found, invalid input/command, schema mismatch/migration required, conflict, and internal failure.

Init writes `meta.authority_domain_id`. Public adapters set `AGENT_KB_EXPECTED_DOMAIN`; mismatch or a bound adapter attaching to a legacy unbound database fails closed. Existing in-process callers may open an existing unbound schema-v3 database when no expected domain is configured.

Structured upsert/promote input rejects unknown fields. Tags and canonical IDs remain strict string arrays. Legacy `evidence` string arrays remain accepted and are stored as weak pointers; `evidence_items` accepts strict discriminated objects. CLI and `KbStore.upsert()` both reject requests containing both evidence forms. Full records preserve `evidence` as URI strings and add `evidence_items`. Promotion never uses general upsert semantics to replace an existing durable ID.

`KbStore.assemble()` receives validated input and queries only existing troubleshooting search/ranking. The CLI validates `query`, `risk_class`, deterministic `now`, supplied canonical snippets, live-verified record IDs, and fixed upper bounds (5 memory records, 3 canonical snippets, 6000 packed-context characters); canonical verification from later than `now` is invalid. Staleness uses the inclusive `expires_at <= now` boundary. Required canonical snippets pack before memory. Returned context is always within the configured character limit and exposes `omitted_memory_ids` and `omitted_canonical_ids`. R0/R1 expose a bounded degraded pack; R2/R3 fail closed for missing or omitted live/canonical verification, omitted relevant memory, selected lineage conflicts, canonical overflow, or context overflow. The pure assembler performs no external calls. T1 provisional lifecycle, orchestration, wrappers/connectors, embeddings, event journaling, and automatic capture remain out of scope.

## Portable skill and optional legacy integration

The source skill is `skills/agent-memory-vault/SKILL.md`. Bootstrap installs it at `~/.agents/skills/agent-memory-vault/SKILL.md` using private user directories. An absent target is copied, a byte-identical target is accepted, and a differing target is a fail-closed conflict that is never overwritten.

The skill uses cwd contract-vault discovery and only the root `./kb` launcher. It provides search/get, handoff, proposal, promotion, and fail-closed assembly mechanics while deferring behavior, authority, lifecycle, and safety policy to `CONTRACT.md`. Portable assembly may perform a first pass and reassemble with verified canonical snippets, but it must never supply generic CLI `live_verified_record_ids`; no portable verifier-owned wrapper exists in Stage 0, so an R2/R3 live-verification requirement remains blocked.

The repository's `extension/` directory remains optional Pi integration outside the deployable template. Its Stage-0 source exposes strict schema-v3 write fields, a generic `kb_assemble` that cannot accept receipts or live-verification ids, and a specialized `kb_git_preflight_assemble` fixed to `troubleshoot:git-prepush-canary`, `/var/home/marcin/Repo/agent-kb`, `origin`, and `https://github.com/CoreSaint/agent-kb`. The public specialized schema has no record-id input. Before any Git command, the wrapper requires the fixed record to be an active/done troubleshoot with approved Git live evidence, no unrelated live URI, and no pointer. The verifier performs only bounded, non-interactive Git reads, never fetches, blocks when the remote object is absent locally, repeats root/branch/HEAD/clean-status/remote-URL checks after ancestry, and then requires a second identical remote ref and SHA before issuing a receipt. Its minimal environment inherits only `PATH`, neutralizes HOME/XDG and system/global Git configuration, disables helpers/prompts/askpass, and suppresses unapproved remote output. R2/R3 gate success remains distinct from domain and external-write authorization.

## Acceptance checks

Every executable check uses disposable cwd, HOME, and database paths. `scripts/test-cli-contract.mjs` covers the JSON/SQLite contract; `scripts/test-vault-discovery.mjs` covers path precedence and no-create discovery; `scripts/smoke-vault-template.mjs` copies the scaffold, supplies this repository as its local tool without network/global installation, and verifies launcher, init/status, ignore rules, absent/identical/conflicting skill installation, private modes, conflict preservation, and cleanup. A disposable Codex acceptance repeats bootstrap and a handoff → proposal → promote → search/get workflow under a temporary HOME.

`scripts/smoke-mnemosyne-slice2.mjs` loads repository extension source through Pi's model-free extension loader and uses disposable schema-v3 databases plus an injected deterministic Git runner. It covers strict tool schemas, v3 evidence variants, dual-evidence rejection, fixed canary binding and evidence failures, arbitrary-record injection, both-pass state changes, minimal runner-environment construction, the read-only command allowlist, credential-output suppression, generic/trusted assembly boundaries, receipt failures, R0/R1 bounds, and the absence of a mutation path. It performs no network operation. Real `ls-remote`, live migration/deployment, active skill changes, and Pi activation smoke are deferred to separately authorized cutover stages.

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
npm run smoke:mnemosyne-slice1
npm run smoke:mnemosyne-slice2
node --check src/assembler.ts
node --check src/cli.ts
node --check src/git-prepush-verifier.ts
node --check extension/index.ts
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
