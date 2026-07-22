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

## Handoff command

To capture a handoff allowed by the contract:

```sh
printf '%s\n' '{"id":"handoff:<id>","type":"handoff","title":"<title>","summary":"<state and next action>","source":"agent"}' \
  | ./kb upsert --input - --json
```

Include the contract-required continuity details in the structured fields.

## Proposal and promotion commands

To capture a proposal allowed by the contract:

```sh
printf '%s\n' '{"id":"proposal:<id>","type":"proposal","title":"<title>","summary":"<claim and evidence>","evidence":["<source>"],"source":"agent"}' \
  | ./kb upsert --input - --json
```

After the contract-required review, promote to the appropriate durable type:

```sh
printf '%s\n' '{"id":"decision:<id>","type":"decision"}' \
  | ./kb promote proposal:<id> --input - --json
```

Choose the durable type and canonical Markdown destination defined by `CONTRACT.md`. Use `./kb help` for complete syntax and accepted JSON fields.
