# Vault contract

## Purpose and authority

This contract is the complete behavioral authority for this portable vault. Reviewed, typed Markdown is the human-facing authority for vault knowledge. Repositories, tickets, and live systems remain authoritative for their current state. The vault-local `.agent-kb/kb.sqlite` is private agent runtime memory; it supports recall and continuity but does not replace Markdown or a current source system.

## Core rules

- Search existing Markdown and runtime memory before creating anything. Keep one canonical home for each claim or artifact; link to it rather than copying it.
- Verify mutable claims against their current authoritative source before relying on them or presenting them as current.
- Reading context grants no authority to mutate an external system. Publishing, pushing, sending, changing tickets, deploying, accessing production, and any other external write require explicit authorization for that action.
- Never store secrets, credentials, tokens, private keys, session material, or secret values in Markdown, SQLite, command examples, evidence, or metadata. Stop and report the issue instead.

## Type routing

Route human-facing material only to the scaffold locations:

- `projects/` for project context and plans.
- `handoffs/` for active-work continuity.
- `knowledge/decisions/` for reviewed decisions.
- `knowledge/procedures/` for reviewed repeatable procedures.
- `knowledge/research/` for research questions and evidence.
- `knowledge/troubleshooting/` for diagnosed failures and fixes.
- `references/` for durable landscape facts, pointers, and source references.
- `deliverables/` for completed outputs.
- `inbox/` for material not yet classified.

## Runtime record lifecycle

The runtime record types and their human-facing destinations are:

| Runtime type | Purpose and Markdown destination |
| --- | --- |
| `handoff` | Active continuity; summarize human-facing state in `handoffs/` when useful. |
| `proposal` | Uncertain durable conclusion; no canonical Markdown destination until reviewed. |
| `decision` | Reviewed choice; `knowledge/decisions/`. |
| `procedure` | Reviewed repeatable method; `knowledge/procedures/`. |
| `troubleshoot` | Diagnosed failure and fix; `knowledge/troubleshooting/`. |
| `landscape` | Durable facts, topology, or pointers; `references/`. Research evidence may remain in `knowledge/research/`. |
| `preference` | Agent-runtime guidance by default. If it would change vault behavior, propose a `CONTRACT.md` change; otherwise a human chooses an appropriate project or reference home when a human-facing record is needed. |

Use a handoff for bounded active work that must survive a session. A useful handoff records verified current state, blockers or stop conditions, and the next concrete action. Capture a possible durable conclusion as a proposal while it is uncertain. Promote it to the appropriate durable type only after deliberate review. When the result has human-facing value, place it in the destination above; runtime promotion does not update Markdown automatically.

Keep claims attributable to evidence. Update the canonical record when facts change, or explicitly supersede it when replacement history matters; do not create competing duplicates. Re-check mutable claims when they are used and record verification when the format supports it.

## Runtime-memory failure

Use only the vault-local `./kb` attachment. If SQLite is unavailable or attachment fails, continue from authoritative Markdown when safe and report the degraded recall. Do not initialize, select, or create an alternate database implicitly, and do not bypass a fail-closed attachment error.

## Human control

Contract changes and procedure changes that alter behavior require human approval. Agents may draft such changes as proposals, but must not treat them as approved authority.

## Portable names and links

Use concise, descriptive, portable names; prefer lowercase kebab-case where no established naming scheme applies. Use vault-relative links and paths. Avoid machine-specific absolute paths, hostnames, user names, and environment details.
