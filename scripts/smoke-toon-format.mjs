#!/usr/bin/env node
/**
 * Smoke test for TOON hit rendering (search tool output).
 */
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "agent-kb-toon-"));
const dbPath = join(dir, "t.sqlite");
process.env.HOME = join(dir, "home");
process.env.AGENT_KB_PATH = dbPath;
if (!resolve(process.env.AGENT_KB_PATH).startsWith(`${resolve(dir)}/`)) throw new Error("Disposable DB escaped test root.");
process.chdir(dir);
const kb = join(import.meta.dirname, "../bin/kb");
const env = { ...process.env };

const { formatHitsToon, toonCell, HIT_FIELDS } = await import(
  pathToFileURL(join(import.meta.dirname, "../src/format.ts")).href
);

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("OK:", msg);
  }
}

assert(HIT_FIELDS.includes("id") && HIT_FIELDS.includes("summary"), "hit field list");

assert(toonCell("plain") === "plain", "plain cell");
assert(toonCell("type:name") === "type:name", "colon in id unquoted");
assert(toonCell(null) === "", "null cell");
assert(toonCell("a,b") === '"a,b"', "comma quoted");
assert(toonCell('say "hi"') === '"say \\"hi\\""', "quotes escaped");
assert(toonCell("line1\nline2") === '"line1\\nline2"', "newline escaped");

const empty = formatHitsToon([]);
assert(empty === "hits[0]{id,type,status,project,confidence,title,summary}:", "empty hits header");

const recs = [
  {
    id: "landscape:cerebras-knowledge-architecture",
    type: "landscape",
    title: "Cerebras Knowledge, internal",
    status: "active",
    project: "knowledge-systems",
    tags: ["cerebras"],
    body: "LONG BODY SHOULD NOT APPEAR",
    summary: "Federated enterprise retrieval.",
    confidence: "high",
    evidence: ["https://example.com"],
    promoted_from: null,
    superseded_by: null,
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    last_verified_at: "2026-07-20",
    source: "user",
  },
  {
    id: "decision:demo",
    type: "decision",
    title: "Demo",
    status: "active",
    project: null,
    tags: [],
    body: "body",
    summary: "short",
    confidence: "medium",
    evidence: [],
    promoted_from: null,
    superseded_by: null,
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    last_verified_at: null,
    source: "user",
  },
];

const toon = formatHitsToon(recs);
console.log("--- sample ---\n" + toon + "\n--------------");
assert(toon.startsWith("hits[2]{id,type,status,project,confidence,title,summary}:"), "header with count");
assert(toon.includes("landscape:cerebras-knowledge-architecture"), "id present");
assert(toon.includes('"Cerebras Knowledge, internal"'), "title with comma quoted");
assert(!toon.includes("LONG BODY"), "body omitted");
assert(!toon.includes("https://example.com"), "evidence omitted");
assert(toon.includes("decision:demo") && toon.includes(",,"), "null project empty cell");

// CLI path: default TOON, --json full

function kbRun(args) {
  return spawnSync(kb, args, { env, encoding: "utf8" });
}

kbRun(["init"]);
kbRun([
  "upsert",
  "--id",
  "handoff:toon-demo",
  "--type",
  "handoff",
  "--title",
  "TOON demo",
  "--summary",
  "compact hits",
  "--status",
  "open",
  "--durable",
]);
const search = kbRun(["search", "toon", "--type", "handoff"]);
assert(search.status === 0, "cli search exit 0");
assert(search.stdout.includes("hits[") && search.stdout.includes("handoff:toon-demo"), "cli search TOON");
assert(!search.stdout.trimStart().startsWith("["), "cli search not JSON array");

const searchJson = kbRun(["search", "toon", "--type", "handoff", "--json"]);
assert(searchJson.status === 0, "cli search --json exit 0");
const searchEnvelope = JSON.parse(searchJson.stdout);
assert(searchEnvelope.ok === true && searchEnvelope.contract_version === "1", "cli search --json envelope");
assert(searchEnvelope.data[0].summary === "compact hits", "cli search --json has summary");

process.chdir(tmpdir());
rmSync(dir, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll TOON format smoke checks passed.");
