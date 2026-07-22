# Agent adapter

If `INIT.md` is present, process it completely before normal work.

Read `CONTRACT.md` first, then `MAP.md`.

When the host supports global skills, load and use `agent-memory-vault` for command-oriented execution.

When global skills are unsupported, `CONTRACT.md` remains the complete behavioral authority and `./kb help` supplies CLI syntax.

This adapter adds no rules and must not become a parallel source of truth.
