---
name: agent-memory-vault
description: Work safely with a contract vault's Markdown authority and vault-local agent memory.
---

# Agent memory vault

Use this skill when the cwd is inside a vault whose root contains `CONTRACT.md` and `MAP.md`. `CONTRACT.md` owns behavior and wins if this command guide conflicts with it.

## Start

1. Walk upward from the physical cwd to the nearest directory containing both marker files; work from that vault root.
2. If `INIT.md` exists, process it completely before normal work.
3. Read `CONTRACT.md`, then `MAP.md`, then `AGENTS.md` when present.
4. Use only the vault-root `./kb` launcher. Do not bypass it or choose another database path.

The contract's authority, external-write gates, lifecycle, and strict secret prohibition apply to every command below.

## Recall commands

Use the contract-required search-before-create flow:

```sh
./kb search "<question>"
./kb get <selected-id> --json
```

If `./kb` reports `DB_NOT_INITIALIZED`, a domain mismatch, or another attachment failure, stop memory operations and report it. Do not initialize implicitly, create another database, or bypass fail-closed attachment.

## Phase 5 troubleshooting assembly

Normal recall remains `./kb search` then `./kb get`. Use `./kb assemble --input - --json` only when operational troubleshooting context may influence a state change.

1. Run an R0-R3 first pass without `live_verified_record_ids` or invented receipts to discover stale/live/canonical requirements.
2. Open the named canonical authorities directly. You may reassemble with at most three verified canonical snippets.
3. Never supply `live_verified_record_ids` through the generic portable `./kb assemble` command. Although the CLI accepts that core field, this portable workflow has no verifier-owned wrapper and cannot establish its provenance.
4. If R2/R3 requires live verification, stop blocked and report that a separately reviewed and approved portable verifier wrapper is required. The Pi extension wrapper is not a portable CLI capability and must not be implied or substituted.
5. When R2/R3 can pass using canonical evidence alone, require `gate.allowed=true`. This risk gate is necessary but never authorization: independently enforce every contract, domain, and external-write approval before any mutation.

Assembly is read-only context preparation. It does not execute, approve, or imply an external write.

## Handoff command

To capture a handoff allowed by the contract:

```sh
printf '%s\n' '{"id":"handoff:<id>","type":"handoff","title":"<title>","summary":"<state and next action>","source":"agent"}' \
  | ./kb upsert --input - --json
```

Include the contract-required continuity details in the structured fields.

## Proposal and promotion commands

For ordinary proposals, legacy pointer evidence remains compatible:

```sh
printf '%s\n' '{"id":"proposal:<id>","type":"proposal","title":"<title>","summary":"<claim and evidence>","evidence":["<source>"],"source":"agent"}' \
  | ./kb upsert --input - --json
```

For troubleshoot proposals, prefer schema-v3 fields when known. `assertion_basis` is `asserted` only for direct user, canonical-source, or tool observation; agent synthesis is `inferred`. Evidence strength is separate: a snapshot requires its actual observation time and SHA-256 content hash, live evidence needs a resolvable source for later recheck, and a pointer is weak. Supply `as_of` only when known, leave `expires_at` null when no expiry is justified, and use only `canonical_ids` that resolve to authority. Never submit both `evidence` and `evidence_items`.

After the contract-required review, promote to the appropriate durable type:

```sh
printf '%s\n' '{"id":"decision:<id>","type":"decision"}' \
  | ./kb promote proposal:<id> --input - --json
```

Incomplete R2-relevant evidence must be reported during Slice 2 review, but it does not authorize automatic promotion or alter promotion transaction rules. Never auto-promote and never write Hindsight.

Choose the durable type and canonical Markdown destination defined by `CONTRACT.md`. Use `./kb help` for complete syntax and accepted JSON fields.
