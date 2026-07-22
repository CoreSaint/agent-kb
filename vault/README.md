# Agent memory vault

This folder is a copyable human-and-agent workspace. Open a shell-capable agent in this directory. If `INIT.md` exists, the agent must complete it before normal work.

Markdown is the human-facing authority for policy, navigation, and reviewed project knowledge. The vault-local `.agent-kb/kb.sqlite` is runtime memory for agents; it is private, ignored, and never replaces the Markdown authority.

Use the local launcher as `./kb`. Agents search before writing, use handoffs for active continuity, capture uncertain durable knowledge as proposals, and promote it deliberately. Never store credentials or secrets.
