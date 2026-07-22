# Agent rules

If `INIT.md` exists, process it completely before normal work.
These in-folder rules are the complete fallback when a harness does not load the reusable skill.

## Authority

- Read `CONTRACT.md` and `MAP.md` first.
- Reviewed Markdown is human-facing authority. SQLite is agent runtime memory; never edit it directly.
- Never store secrets, credentials, tokens, or private session data.

## Memory workflow

1. Search before relying on memory or creating a record: `./kb search "<question>"`.
2. Read a selected record with `./kb get <id> --json` and verify mutable claims against their real source.
3. Use a handoff for active multi-session work and a proposal for a possible durable conclusion.
4. Write structured records through `./kb upsert --input - --json`; run `./kb help` for the accepted JSON fields.
5. Promote a proposal only after review. Update or supersede stale knowledge instead of creating duplicates.
6. Put reviewed, human-facing knowledge in the matching Markdown directory and keep `MAP.md` useful.

If SQLite is unavailable, continue from Markdown when safe and report the memory failure rather than silently creating another database.
