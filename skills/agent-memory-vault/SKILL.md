---
name: agent-memory-vault
description: Work safely with a contract vault's Markdown authority and vault-local agent memory.
---

# Agent memory vault

Use this skill when the cwd is inside a vault whose root contains `CONTRACT.md` and `MAP.md`.

## Start

1. Walk upward from the physical cwd to the nearest directory containing both marker files; work from that vault root.
2. If `INIT.md` exists, process it completely before normal work.
3. Read `CONTRACT.md`, `MAP.md`, and `AGENTS.md` when present.
4. Use only the vault-root `./kb` launcher. Do not bypass it or choose another database path.

Reviewed Markdown is human-facing authority. SQLite is agent runtime memory and does not override current source systems, repository state, or reviewed Markdown. Never store secrets, credentials, tokens, or private session data.

## Recall

Search concisely before relying on memory or creating records:

```sh
./kb search "<question>"
./kb get <selected-id> --json
```

Verify mutable claims against their authoritative source. If `./kb` reports `DB_NOT_INITIALIZED`, a domain mismatch, or another attachment failure, stop memory operations and report it. Do not initialize implicitly, create another database, or bypass fail-closed attachment.

## Capture active work

Use a handoff for bounded work that another session must continue:

```sh
printf '%s\n' '{"id":"handoff:<id>","type":"handoff","title":"<title>","summary":"<state and next action>","source":"agent"}' \
  | ./kb upsert --input - --json
```

Keep the body concise and include blockers, verified state, and the next concrete action.

## Capture and promote durable knowledge

Record an uncertain durable conclusion as a proposal:

```sh
printf '%s\n' '{"id":"proposal:<id>","type":"proposal","title":"<title>","summary":"<claim and evidence>","evidence":["<source>"],"source":"agent"}' \
  | ./kb upsert --input - --json
```

Promote only after deliberate review:

```sh
printf '%s\n' '{"id":"decision:<id>","type":"decision"}' \
  | ./kb promote proposal:<id> --input - --json
```

Choose the appropriate durable type rather than defaulting blindly to `decision`. Update or supersede stale knowledge instead of creating duplicates. Put reviewed human-facing knowledge in the mapped Markdown directory and keep `MAP.md` useful.
