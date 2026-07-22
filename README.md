# agent-KB

Local typed SQLite knowledge base for agent handoffs, proposals, and promoted durable knowledge.

## Install with an agent

Give a shell-capable coding agent this repository URL and say:

> Install the portable agent-memory vault from https://github.com/CoreSaint/agent-kb into `<destination>`. Follow `INSTALL.md`; do not use sudo or overwrite existing files.

[INSTALL.md](INSTALL.md) is the authoritative first-copy bootstrap. It safely copies the `vault/` template, reuses the checkout as the private local tool, and then hands control to the copied vault's `INIT.md`. Do not initialize the repository's source `vault/` directory in place.

## Memory architecture and authority

agent-KB is the runtime authority for curated agent continuity within its scope, including promoted typed records. In a contract vault, reviewed Markdown remains the human-facing authority. Agent-KB never overrides canonical vault policy or documentation, repository code and repository-local documentation, or live external-system state in their respective domains. Agents should inspect those canonical sources directly before acting when current truth matters; a KB hit provides durable agent knowledge and continuity within its scope, not a replacement for domain authority outside it.

Records have a type-specific lifecycle:

- Agents capture uncertain durable knowledge as an open `proposal`. Explicit promotion creates an active durable `decision`, `procedure`, `troubleshoot`, `landscape`, or `preference`, then marks the proposal `promoted`.
- `handoff` records carry bounded work-in-progress continuity and move from `open` or `blocked` to `closed`, then may be archived.
- Durable records remain active until explicitly superseded, deprecated, or archived. Maintenance reports lifecycle candidates but does not silently promote or rewrite knowledge.

Schema v2 keeps promotion provenance and replacement lineage independent. `promoted_from` points from a durable record to its source proposal or explicitly promoted handoff. `superseded_by` points from an older record to its replacement. Promoting sets `promoted_from`; superseding sets `superseded_by` without erasing promotion provenance.

Session transcripts and observational summaries are execution context, not durable knowledge sources or ingestion feeds. They do not promote records, replace handoffs, or become authoritative agent-KB content.

Explicit non-goals:

- no whole-repository memory or repository indexing;
- no automatic transcript or observational-memory promotion;
- no Hindsight capture or mutation;
- no embeddings, vector retrieval, or active recall yet.

## Copyable vault template

`vault/` is the minimal agent-agnostic deployable scaffold; the folder name does not rename the `kb` CLI or `.agent-kb/kb.sqlite`. Copy it, open a shell-capable agent in the copied root, and let the agent process `INIT.md` before normal work. Bootstrap checks Git and Node.js 26+, installs the repository into ignored `.agent-kb/tool/`, installs the reusable source skill at `~/.agents/skills/agent-memory-vault/SKILL.md`, initializes vault-local SQLite through `./kb`, verifies status/path/modes, and removes `INIT.md` only after every check succeeds. `CONTRACT.md` remains the complete in-folder authority when global skills are unavailable; `AGENTS.md` is only a thin host/harness adapter.

The automated template smoke test never clones or installs globally. It copies the scaffold to a disposable directory, supplies this repository as the local tool checkout, and installs the skill only below a temporary `HOME`.

## CLI and database attachment

Only `kb init` creates a parent directory, SQLite file, schema, or authority metadata. Every command that reads or writes records requires an existing initialized database and fails with `DB_NOT_INITIALIZED` instead of creating one. `help`, `version`, `contract`, and `path` do not open the database. Migration also requires an existing schema-v1 database.

```sh
export AGENT_KB_PATH=/private/agent-kb/kb.sqlite
./bin/kb init
./bin/kb status
./bin/kb upsert --id handoff:demo --type handoff --title "Demo" --summary "Open handoff"
./bin/kb search demo --type handoff
./bin/kb promote proposal:demo --type decision --id decision:demo
```

Database path precedence is deterministic:

1. A non-empty `AGENT_KB_PATH` is the explicit highest-priority override.
2. Otherwise, agent-KB resolves the physical process working directory and walks upward to the first directory containing regular files named both `CONTRACT.md` and `MAP.md`. That contract vault uses `<vault>/.agent-kb/kb.sqlite`.
3. If no contract vault is found, the compatibility fallback remains `~/.local/share/agent-kb/kb.sqlite`.

Physical resolution means a cwd reached through a symlink discovers the vault containing the symlink target, not the directory containing the symlink. Path resolution and ordinary reads never create `.agent-kb` or SQLite files. Explicit init may create `.agent-kb` with mode `0700`, creates the schema-v2 database with mode `0600`, and never changes the contract-vault root's permissions. Init also stores a generated, non-secret authority-domain UUID. Tests may supply a validated UUID with `kb init --authority-domain UUID`; `kb status` returns it without mutation.

Public adapters should bind attachment by setting `AGENT_KB_EXPECTED_DOMAIN` to the UUID returned by init or status. A wrong UUID, or any expected UUID against a legacy unbound schema-v2 database, fails closed with `DOMAIN_MISMATCH`. Existing in-process callers remain compatible: an existing schema-v2 database without authority metadata opens when no expected-domain binding is supplied, and status reports a null domain until it is explicitly reinitialized outside this contract slice.

- `kb search` defaults to **TOON** compact hits (id, type, status, project, confidence, title, summary).
- Other interactive commands retain readable JSON output.
- Machine callers pass `--json`; success and error output then follows the versioned contract below.

## Public JSON CLI contract

Protocol version `1` uses one JSON object on stdout and no stderr output in machine mode:

```json
{"ok":true,"contract_version":"1","command":"status","data":{}}
{"ok":false,"contract_version":"1","command":"get","error":{"code":"NOT_FOUND","message":"Record not found: missing."}}
```

Exit `0` means success, `2` means a stable contract error, and `1` means `INTERNAL_FAILURE`. Stable codes are `DB_NOT_INITIALIZED`, `DOMAIN_MISMATCH`, `NOT_FOUND`, `INVALID_INPUT`, `INVALID_COMMAND`, `SCHEMA_MISMATCH`, `MIGRATION_REQUIRED`, `CONFLICT`, and `INTERNAL_FAILURE`. `kb version --json` and `kb contract --json` expose package/protocol details without opening a database.

Machine writes use JSON input from a file or stdin. Unknown fields and invalid types are rejected; arrays remain arrays and need no CSV or shell encoding. JSON upserts default omitted provenance to `source: "agent"` rather than `"user"`.

```sh
printf '%s\n' '{"id":"proposal:demo","type":"proposal","title":"Demo","tags":["one,two"],"evidence":["local,observation"],"source":"agent"}' \
  | ./bin/kb upsert --input - --json
printf '%s\n' '{"id":"decision:demo","type":"decision"}' \
  | ./bin/kb promote proposal:demo --input - --json
```

Promotion takes an immediate SQLite write transaction, rejects an existing durable ID, creates exactly one durable lineage record, and marks a proposal promoted atomically. Concurrent promotion attempts produce one success and one `CONFLICT`.
## Schema-v1 migration

Normal open, search, and get operations refuse schema-v1 databases; they never migrate implicitly. Set `AGENT_KB_PATH` to the intended database, preview first, inspect every ambiguity, and only then apply:

```sh
AGENT_KB_PATH=/private/disposable-copy.sqlite ./bin/kb migrate
AGENT_KB_PATH=/private/disposable-copy.sqlite ./bin/kb migrate --apply
```

Preview opens the database read-only. Apply supports schema v1 only, runs in one transaction, updates `meta.schema_version` last, verifies SQLite integrity, and refuses reapplication after schema v2. Migration classifies only these preserved facts:

- a durable record pointing to an existing proposal or handoff becomes `promoted_from`;
- any record pointing to an existing durable record becomes `superseded_by`;
- missing targets, self-links, and unsafe source/target type combinations are not inferred.

Every unclassified legacy pair is retained with a reason in `lineage_migration_ambiguities`. Migration output is metadata-only and bounded to 100 ambiguity rows and 100 promoted-proposal review rows, with totals and truncation flags. `maintain` exposes the same durable ambiguity audit without bodies or evidence. Promoted proposals with zero or multiple explicit durable targets stay visible for review and cannot be pruned.

Example: promoting `proposal:cache` creates `decision:cache` with `promoted_from: "proposal:cache"` and `superseded_by: null`. Later superseding it with `decision:cache-v2` changes only `decision:cache.superseded_by`; its `promoted_from` remains `"proposal:cache"`.

## Search

`kb search` uses hybrid lexical retrieval over FTS5 (no embeddings or LLM). It builds exact-ID, phrase, AND, title/tags, and OR lists, then applies Reciprocal Rank Fusion (RRF) with $K=60$ and list weights $3$, $2$, $1.5$, $1.5$, and $1$. For candidate $d$, raw lexical relevance is:

$$R(d)=\sum_l \frac{w_l}{60+\operatorname{rank}_l(d)}$$

Ranking normalizes lexical relevance against the strongest candidate for the current filtered query, $L(d)=R(d)/\max_j R(j)$, so $L\in[0,1]$. Status, type, confidence, and type-aware freshness retain their explicit component scores. Their raw sum $m$ is mapped to a bounded contribution:

$$M(d)=0.05\times\begin{cases}
\operatorname{clamp}(m/0.32,-1,1),&m\geq0\\
\operatorname{clamp}(m/0.36,-1,1),&m<0
\end{cases}$$

The final score is $S(d)=L(d)+M(d)+2I_{\mathrm{exact}}(d)$. A non-exact score is in $[-0.05,1.05]`; metadata can resolve a lexical near-tie but cannot reverse a normalized lexical gap greater than $0.1$. The exact-ID bonus separates a permitted exact hit from every non-exact hit. Final ties use ascending record ID. Empty/non-token queries retain `updated_at` recency ordering under the same filters and do not apply score reranking.

Default search rendering remains minimal TOON (id, type, status, project, confidence, title, summary); `--json` returns the full-record array inside the version-1 success envelope. `kb search <query> --explain` and core `KbStore.searchWithDiagnostics()` return compact JSON diagnostics with the same identity fields plus ranking mode, exact-ID flag, raw RRF, normalized lexical score, four metadata components and their raw/bounded totals, exact-ID bonus, final score, and every contributing retrieval-list name, weight, rank, and RRF contribution. Explain output intentionally excludes tags, body, evidence, lineage, source, and timestamps. The Pi `kb_search` tool exposes the same bounded contract only when `explain: true`; its default TOON output is unchanged.

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

- `maintain` is read-only. It categorizes stale open/blocked handoffs; promoted proposals and their explicit `promoted_from` durable-target linkage count; rejected proposals; closed/archived handoffs; inactive durable records; active/done durable records without `last_verified_at`; and bounded schema-migration ambiguities. It also reports the database path, main-file size, and `PRAGMA quick_check`.
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

Run checks only with explicit temporary cwd, HOME, and database paths. Template validation installs the portable skill only below its temporary HOME:

```sh
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
```
