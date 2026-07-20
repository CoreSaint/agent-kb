#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { formatHitsToon } from "./format.ts";
import { createStore } from "./store.ts";
import type { KbRecord } from "./types.ts";

function parse(argv: string[]): { cmd: string; args: string[]; flags: Record<string, string | boolean> } {
  const [cmd = "help", ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) { args.push(token); continue; }
    const eq = token.indexOf("=");
    if (eq > 2) { flags[token.slice(2, eq)] = token.slice(eq + 1); continue; }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) { flags[name] = next; i++; } else flags[name] = true;
  }
  return { cmd, args, flags };
}
function list(value: unknown): string[] | undefined {
  if (value === undefined || value === true) return undefined;
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}
function str(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name]; return typeof v === "string" ? v : undefined;
}
function body(flags: Record<string, string | boolean>): string | undefined {
  const file = str(flags, "body-file");
  if (file) return readFileSync(file, "utf8");
  return str(flags, "body");
}
function out(value: unknown, flags: Record<string, string | boolean>): void {
  if (flags.human) { console.log(value); return; }
  console.log(JSON.stringify(value, null, 2));
}
/** Search defaults to TOON hits; --json dumps full records. */
function outSearch(records: KbRecord[], flags: Record<string, string | boolean>): void {
  if (flags.json) {
    out(records, flags);
    return;
  }
  if (flags.human) {
    console.log(records);
    return;
  }
  console.log(formatHitsToon(records));
}
function usage(): string {
  return `kb init
kb path
kb search <query> [--type t] [--status s] [--project p] [--limit n] [--json]
kb get <id>
kb upsert --id --type --title [--status] [--project] [--tags a,b] [--summary] [--body-file f] [--body] [--confidence] [--evidence e1,e2] [--source] [--durable]
kb promote <proposalId> --type decision|procedure|troubleshoot|landscape|preference [--id newId] [--title] [--status active|done] ...
kb close <id> [--status closed|archived]
kb supersede <oldId> <newId>
kb purge-candidates [--stale-days 14]`;
}

const { cmd, args, flags } = parse(process.argv.slice(2));
const store = createStore();
try {
  switch (cmd) {
    case "init": out(store.init(), flags); break;
    case "path": console.log(store.path()); break;
    case "search": outSearch(store.search(args.join(" "), { type: str(flags,"type"), status: str(flags,"status"), project: str(flags,"project"), limit: Number(str(flags,"limit") ?? 20) }), flags); break;
    case "get": { const rec = store.get(args[0]); if (!rec) throw new Error(`Record not found: ${args[0]}`); out(rec, flags); break; }
    case "upsert": out(store.upsert({ id: str(flags,"id")!, type: str(flags,"type") as any, title: str(flags,"title")!, status: str(flags,"status"), project: str(flags,"project"), tags: list(flags.tags), summary: str(flags,"summary"), body: body(flags), confidence: str(flags,"confidence") as any, evidence: list(flags.evidence), source: str(flags,"source") as any }, { forceDurable: Boolean(flags.durable) }), flags); break;
    case "promote": out(store.promote(args[0], { id: str(flags,"id"), type: str(flags,"type") as any, title: str(flags,"title"), status: str(flags,"status") as any, project: str(flags,"project"), tags: list(flags.tags), summary: str(flags,"summary"), body: body(flags), confidence: str(flags,"confidence") as any, evidence: list(flags.evidence) }), flags); break;
    case "close": out(store.close(args[0], str(flags,"status") ?? "closed"), flags); break;
    case "supersede": out(store.supersede(args[0], args[1]), flags); break;
    case "purge-candidates": out(store.purgeCandidates(Number(str(flags,"stale-days") ?? 14)), flags); break;
    case "status": out(store.status(), flags); break;
    default: console.error(usage()); process.exitCode = 2;
  }
} catch (err) {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2));
  process.exitCode = 1;
} finally {
  store.dispose();
}
