# agent-KB

Local typed SQLite knowledge base for Pi agent handoffs, proposals, and promoted durable knowledge.

## CLI

```sh
export AGENT_KB_PATH=/tmp/agent-kb.sqlite # optional
./bin/kb init
./bin/kb upsert --id handoff:demo --type handoff --title "Demo" --summary "Open handoff"
./bin/kb search demo --type handoff
./bin/kb promote proposal:demo --type decision --id decision:demo
```

Default database path is `~/.local/share/agent-kb/kb.sqlite`; `AGENT_KB_PATH` overrides it. Output is JSON by default.

## Search

`kb search` uses hybrid lexical retrieval over FTS5: exact id, phrase, AND, title/tags, and OR candidate lists are fused with Reciprocal Rank Fusion, then lightly reranked by status, type, confidence, and type-aware freshness (no embeddings, no LLM). Empty queries list by `updated_at` under the same filters. Promoted/deprecated/superseded records are demoted unless an explicit status filter requests them.
