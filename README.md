# agent-KB

Local typed SQLite knowledge base for agent handoffs, proposals, and promoted durable knowledge.

## Core installation and runtime

agent-KB is standalone. Install the package with Node 26, then initialize its agent-KB-owned database:

```sh
npm install
./bin/kb init
./bin/kb status
```

The default database is exactly `$HOME/.local/share/agent-kb/kb.sqlite`, independent of the working directory, vault markers, symlinks, or repository location. Only `kb init` creates it. Ordinary commands fail closed when it is absent, invalid, needs migration, or does not match `AGENT_KB_EXPECTED_DOMAIN`.

`AGENT_KB_PATH` is an explicit highest-priority development/test override:

```sh
export AGENT_KB_PATH=/private/agent-kb/kb.sqlite
./bin/kb init
./bin/kb status
```

New databases receive an authority-domain UUID. Public adapters must pin both the database path and `AGENT_KB_EXPECTED_DOMAIN`. To attach a pre-existing schema-v3 unbound database without reinitializing it, use the administrative one-transaction operation:

```sh
AGENT_KB_PATH=/private/existing.sqlite \
  ./bin/kb bind-domain --authority-domain 123e4567-e89b-42d3-a456-426614174000 --json
```

It validates schema and SQLite integrity, refuses an already-bound database (including the same UUID), and never returns record bodies.

## Optional vault integration kit

`vault/`, `skills/agent-memory-vault/`, `INSTALL.md`, and the release installer are optional portable vault-integration assets. They are not needed to install or operate agent-KB core. They retain their own installer and integration tests; their vault-local `.agent-kb` arrangement is not a core default and core resolution never discovers it.

## Memory architecture and authority

agent-KB is the runtime authority for curated continuity within its own records. It never overrides canonical repository code and documentation, reviewed vault policy, or live external-system state. Records are explicit proposals, handoffs, and promoted durable knowledge; schema/search/ranking behavior remains local and lexical.

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
## Explicit schema migrations

Normal open, search, and get operations refuse schema-v1 and schema-v2 databases; they never migrate implicitly. Set `AGENT_KB_PATH` to the intended database, preview one step, inspect it, and only then apply:

```sh
AGENT_KB_PATH=/private/disposable-copy.sqlite ./bin/kb migrate
AGENT_KB_PATH=/private/disposable-copy.sqlite ./bin/kb migrate --apply
```

Each invocation advances one version. Schema v1→v2 retains the existing lineage classification behavior; run preview/apply again for v2→v3. Every preview opens read-only. Every apply is one transaction, updates `meta.schema_version` last among mutations, runs integrity checks, and refuses reapplication.

- a durable record pointing to an existing proposal or handoff becomes `promoted_from`;
- any record pointing to an existing durable record becomes `superseded_by`;
- missing targets, self-links, and unsafe source/target type combinations are not inferred.

Every unclassified legacy pair is retained with a reason in `lineage_migration_ambiguities`. Migration output is metadata-only and bounded to 100 ambiguity rows and 100 promoted-proposal review rows, with totals and truncation flags. `maintain` exposes the same durable ambiguity audit without bodies or evidence. Promoted proposals with zero or multiple explicit durable targets stay visible for review and cannot be pruned.

Example: promoting `proposal:cache` creates `decision:cache` with `promoted_from: "proposal:cache"` and `superseded_by: null`. Later superseding it with `decision:cache-v2` changes only `decision:cache.superseded_by`; its `promoted_from` remains `"proposal:cache"`.

Schema v3 adds nullable `assertion_basis` (`asserted` or `inferred`), nullable `as_of`, nullable `expires_at`, and `canonical_ids` as a JSON string array. Existing records migrate with a null assertion basis and timestamps rather than invented certainty. The existing `evidence` SQLite JSON text now stores discriminated objects:

- `snapshot`: `uri`, `observed_at`, and a SHA-256 content hash; strongest reproducible evidence;
- `live`: `uri` and optional `checked_at`; mutable evidence whose current verification is supplied by a wrapper;
- `pointer`: `uri`; weak discovery or legacy evidence.

The v2→v3 migration wraps every legacy evidence string as `{ \"kind\": \"pointer\", \"uri\": \"...\" }` without fabricating a timestamp or hash. Full-record API output retains the legacy `evidence` URI-string array and adds `evidence_items` with the typed objects; this preserves existing readers while exposing evidence strength.

## Slice-1 context assembly

`kb assemble --input <file|-> --json` accepts `query`, `risk_class` (`R0`–`R3`), optional deterministic `now`, verified `canonical_snippets` (`id`, `text`, `verified_at`), supplied `live_verified_record_ids`, and optional `limits`. Defaults cap selected troubleshooting records at 5, canonical snippets at 3, and the packed context at 6000 characters. A canonical snippet later than `now` is rejected. Unknown fields, malformed evidence, timestamps, hashes, arrays, limits, and risk classes fail at the boundary.

Assembly uses only the existing lexical search/ranking path and supplied receipts; the core makes no network, model, connector, or external-system calls. It marks a record stale exactly when `expires_at <= now`, exposes typed evidence classes, lineage conflicts when both a record and its `superseded_by` target were selected, required canonical IDs, verification requirements, and an explicit `gate.allowed` plus machine-readable reasons. Authority packing orders required canonical snippets before memory, then orders memory from snapshot/live-backed records through active promoted records to handoff/session-strength material; the T1 provisional tier is reserved but not implemented.

The returned `items` and `canonical_snippets` are always deterministically bounded by `budget.max_context_chars`; `budget.estimated_context_chars` is the exact JSON length of those two packed arrays. `omitted_memory_ids` and `omitted_canonical_ids` make every context omission visible. R0/R1 may return that bounded degraded pack with reasons. R2/R3 fail closed for omitted relevant memory or required authority, mutable or stale troubleshooting records without a supplied live-verification receipt, missing canonical snippets, lineage conflict, canonical-count overflow, or context overflow.

Slice 1 does not provide a universal orchestrator, T1 probation lifecycle, tool-wrapper inventory, embeddings, event journal, automatic capture, or external connectors.

## Slice-2 Stage-0 repository adapters

The repository Pi extension source now exposes schema-v3 write fields plus two strict assembly tools. `kb_assemble` is the generic operational-troubleshooting adapter: it accepts bounded canonical snippets but deliberately has no `live_verified_record_ids` or receipt input, so mutable/stale R2/R3 records remain blocked. `kb_git_preflight_assemble` is the specialized trust boundary for the configured approved repository, remote, and URL canary. Its public schema has no record-id input: only the fixed `troubleshoot:git-prepush-canary` may be projected, after the store proves it is an active/done troubleshoot with at least one approved Git live-evidence URI, no unrelated live URI, and no pointer evidence.

The verifier checks repository root, branch, HEAD, clean status, and exact remote URL both before and after the remote-ref/object/ancestry checks, then requires a second identical remote ref and SHA immediately before receipt issuance. The default runner inherits only `PATH`, replaces HOME/XDG and Git configuration sources with neutral locations, disables credential helpers, terminal prompting, and askpass, bounds time/output, and suppresses every unapproved remote URL. Neither tool mutates Git. `gate.allowed=true` is necessary for R2/R3 reliance but never authorizes push or another external write; domain and external-write approval remain separate. Receipts are immutable, non-secret, in-memory, fresh for at most 60 seconds, never accepted as tool input, and never persisted.

Stage 0 is repository source plus offline fixtures only; it is not deployed. The real `ls-remote` canary, live schema-v3 cutover, installed extension/CLI changes, active skill activation, and fresh-Pi smoke remain deferred to separately authorized cutover stages. Run the deterministic no-network fixture with `npm run smoke:mnemosyne-slice2`.

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
npm run smoke:mnemosyne-slice1
npm run smoke:mnemosyne-slice2
node --check src/cli.ts
node --check src/assembler.ts
node --check src/git-prepush-verifier.ts
node --check extension/index.ts
```
