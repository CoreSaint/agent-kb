#!/usr/bin/env node
/**
 * Smoke test for hybrid lexical search + RRF + metadata rerank.
 * Uses a temp SQLite DB; does not touch the production kb.sqlite.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agent-kb-hybrid-"));
const dbPath = join(dir, "test.sqlite");
process.env.AGENT_KB_PATH = dbPath;

const { createStore } = await import(pathToFileURL(join(import.meta.dirname, "../src/store.ts")).href);

const store = createStore();
store.init();

const seed = [
  {
    id: "proposal:cerebras-knowledge-architecture",
    type: "proposal",
    title: "Cerebras Knowledge internal retrieval architecture",
    status: "promoted",
    project: "knowledge-systems",
    tags: ["cerebras", "enterprise-search", "rag", "hybrid-retrieval"],
    summary: "Federated enterprise retrieval with hybrid lexical and vector signals.",
    body: "Source connectors normalize Slack and code into Postgres. Reciprocal rank fusion merges retrievers.",
    confidence: "high",
    source: "user",
  },
  {
    id: "landscape:cerebras-knowledge-architecture",
    type: "landscape",
    title: "Cerebras Knowledge internal retrieval architecture",
    status: "active",
    project: "knowledge-systems",
    tags: ["cerebras", "enterprise-search", "rag", "hybrid-retrieval"],
    summary: "Federated enterprise retrieval with hybrid lexical and vector signals.",
    body: "Source connectors normalize Slack and code into Postgres. Reciprocal rank fusion merges retrievers.",
    confidence: "high",
    source: "user",
    last_verified_at: "2026-07-20",
  },
  {
    id: "decision:2026-07-19-agent-kb-architecture",
    type: "decision",
    title: "Agent KB architecture (greenfield)",
    status: "active",
    project: "agent-kb",
    tags: ["architecture", "sqlite", "pi"],
    summary: "Typed local SQLite KB with promote gates; no repo memory.",
    body: "Use SQLite FTS5 and explicit promote. Do not index whole git repos.",
    confidence: "high",
    source: "user",
  },
  {
    id: "preference:pi-phase3-hindsight-demoted",
    type: "preference",
    title: "Pi Phase 3 Hindsight demoted",
    status: "active",
    project: "agent-kb",
    tags: ["pi", "phase3", "hindsight", "agent-kb"],
    summary: "Hindsight is legacy/emergency only; stop hermes capture.",
    body: "Read order: agent-KB, vault, then Hindsight on miss only.",
    confidence: "high",
    source: "user",
  },
  {
    id: "proposal:unrelated-noise",
    type: "proposal",
    title: "Unrelated traffic tooling note",
    status: "open",
    project: "traffic-gen",
    tags: ["traffic-gen", "deployment"],
    summary: "Noise record that should not dominate hybrid retrieval for cerebras queries.",
    body: "Something about image hashes and stage2 contracts.",
    confidence: "low",
    source: "agent",
  },
];

for (const row of seed) {
  store.upsert(row, { forceDurable: true });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Exact id
{
  const hits = store.search("landscape:cerebras-knowledge-architecture");
  assert(hits[0]?.id === "landscape:cerebras-knowledge-architecture", "exact id should rank first");
}

// Phrase / multi-token: durable active landscape beats promoted proposal twin and noise
{
  const hits = store.search("Cerebras Knowledge retrieval architecture");
  assert(hits.some((h) => h.id === "landscape:cerebras-knowledge-architecture"), "phrase/AND should find cerebras landscape");
  assert(hits[0]?.id === "landscape:cerebras-knowledge-architecture", "active landscape should beat promoted proposal twin");
  assert(hits.findIndex((h) => h.id === "proposal:cerebras-knowledge-architecture") > 0, "promoted proposal should rank below durable twin");
}

// Title/tag biased short query
{
  const hits = store.search("hindsight demoted");
  assert(hits[0]?.id === "preference:pi-phase3-hindsight-demoted", "title/tags should surface preference first");
}

// Project filter still works
{
  const hits = store.search("architecture", { project: "agent-kb" });
  assert(hits.every((h) => h.project === "agent-kb"), "project filter must hold");
  assert(hits.some((h) => h.id === "decision:2026-07-19-agent-kb-architecture"), "filtered search finds agent-kb decision");
  assert(!hits.some((h) => h.id === "landscape:cerebras-knowledge-architecture"), "filtered search excludes other projects");
}

// Empty query = recency under filters
{
  const hits = store.search("", { type: "proposal" });
  assert(hits.length >= 1 && hits.every((h) => h.type === "proposal"), "empty query with type filter lists proposals");
  assert(hits.some((h) => h.id === "proposal:unrelated-noise"), "empty proposal listing includes noise seed");
}

// Type filter
{
  const hits = store.search("architecture", { type: "decision" });
  assert(hits.every((h) => h.type === "decision"), "type filter must hold");
}

// Explicit status filter still returns demoted statuses when requested
{
  const hits = store.search("Cerebras Knowledge", { status: "promoted" });
  assert(hits.length === 1 && hits[0].id === "proposal:cerebras-knowledge-architecture", "status filter must still surface promoted proposals");
}

store.dispose();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, cases: 7 }, null, 2));
