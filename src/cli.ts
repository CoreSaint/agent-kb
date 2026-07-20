#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { formatHitsToon } from "./format.ts";
import { createStore, type KbStore } from "./store.ts";
import {
  confidences,
  durableTypes,
  recordTypes,
  sources,
  type Confidence,
  type DurableType,
  type KbRecord,
  type RecordType,
  type Source,
} from "./types.ts";

type FlagValue = string | true;
type Flags = Record<string, FlagValue>;

function parse(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq > 2 ? token.slice(2, eq) : token.slice(2);
    if (!name || Object.hasOwn(flags, name)) throw new Error(`Invalid or duplicate flag '${token}'.`);
    if (eq > 2) {
      flags[name] = token.slice(eq + 1);
      continue;
    }
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { cmd, args, flags };
}

function assertFlags(flags: Flags, allowed: readonly string[]): void {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) throw new Error(`Unknown flag '--${name}'.`);
  }
  if (flags.human !== undefined && flags.human !== true) throw new Error("--human does not accept a value.");
  if (flags.json !== undefined && flags.json !== true) throw new Error("--json does not accept a value.");
}

function optionalFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === true) throw new Error(`--${name} requires a value.`);
  return value;
}

function requiredFlag(flags: Flags, name: string): string {
  const value = optionalFlag(flags, name);
  if (value === undefined || !value.trim()) throw new Error(`--${name} is required.`);
  return value;
}

function oneArgument(args: string[], command: string): string {
  if (args.length !== 1 || !args[0].trim()) throw new Error(`${command} requires exactly one id.`);
  return args[0];
}

function noArguments(args: string[], command: string): void {
  if (args.length !== 0) throw new Error(`${command} does not accept positional arguments.`);
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("Comma-separated flags require at least one value.");
  return values;
}

function strictInteger(value: string, name: string, maximum: number): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error(`--${name} must be at most ${maximum}.`);
  return parsed;
}

function recordType(value: string): RecordType {
  const found = recordTypes.find((candidate) => candidate === value);
  if (!found) throw new Error(`Invalid record type '${value}'.`);
  return found;
}

function durableType(value: string): DurableType {
  const found = durableTypes.find((candidate) => candidate === value);
  if (!found) throw new Error(`Invalid durable type '${value}'.`);
  return found;
}

function confidence(value: string | undefined): Confidence | undefined {
  if (value === undefined) return undefined;
  const found = confidences.find((candidate) => candidate === value);
  if (!found) throw new Error(`Invalid confidence '${value}'.`);
  return found;
}

function source(value: string | undefined): Source | undefined {
  if (value === undefined) return undefined;
  const found = sources.find((candidate) => candidate === value);
  if (!found) throw new Error(`Invalid source '${value}'.`);
  return found;
}

function body(flags: Flags): string | undefined {
  const file = optionalFlag(flags, "body-file");
  if (file !== undefined) {
    if (!file.trim() || file.includes("\0")) throw new Error("--body-file must be a non-empty filesystem path.");
    if (flags.body !== undefined) throw new Error("Use only one of --body-file and --body.");
    return readFileSync(file, "utf8");
  }
  return optionalFlag(flags, "body");
}

function out(value: unknown, flags: Flags): void {
  if (flags.human) {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function outSearch(records: KbRecord[], flags: Flags): void {
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
kb purge-candidates [--stale-days 14]
kb maintain [--stale-days 14]
kb archive <id>
kb restore <id> --status <allowed-status>
kb verify <id> --date YYYY-MM-DD
kb backup [--output path]
kb prune [--apply --backup fresh-maintenance-backup]

Maintenance safety:
  maintain and prune default to read-only output without record bodies.
  backup refuses overwrite, uses mode 0600, and verifies quick_check.
  prune --apply requires a matching kb backup no older than 15 minutes.
  retention: linked promoted proposals 30d; linked archived proposals 30d from archival/update; rejected proposals 90d; archived handoffs 90d.
  automatic prune never selects open, blocked, active, or durable records.`;
}

let store: KbStore | undefined;
try {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  store = createStore();
  switch (cmd) {
    case "init":
      assertFlags(flags, ["human"]); noArguments(args, cmd); out(store.init(), flags); break;
    case "path":
      assertFlags(flags, []); noArguments(args, cmd); console.log(store.path()); break;
    case "search": {
      assertFlags(flags, ["type", "status", "project", "limit", "json", "human"]);
      const limitValue = optionalFlag(flags, "limit");
      outSearch(store.search(args.join(" "), {
        type: optionalFlag(flags, "type"),
        status: optionalFlag(flags, "status"),
        project: optionalFlag(flags, "project"),
        limit: limitValue === undefined ? 20 : strictInteger(limitValue, "limit", 100),
      }), flags);
      break;
    }
    case "get":
      assertFlags(flags, ["human"]);
      {
        const id = oneArgument(args, cmd);
        const record = store.get(id);
        if (!record) throw new Error(`Record not found: ${id}.`);
        out(record, flags);
      }
      break;
    case "upsert": {
      assertFlags(flags, ["id", "type", "title", "status", "project", "tags", "summary", "body-file", "body", "confidence", "evidence", "source", "durable", "human"]);
      noArguments(args, cmd);
      if (flags.durable !== undefined && flags.durable !== true) throw new Error("--durable does not accept a value.");
      out(store.upsert({
        id: requiredFlag(flags, "id"),
        type: recordType(requiredFlag(flags, "type")),
        title: requiredFlag(flags, "title"),
        status: optionalFlag(flags, "status"),
        project: optionalFlag(flags, "project"),
        tags: csv(optionalFlag(flags, "tags")),
        summary: optionalFlag(flags, "summary"),
        body: body(flags),
        confidence: confidence(optionalFlag(flags, "confidence")),
        evidence: csv(optionalFlag(flags, "evidence")),
        source: source(optionalFlag(flags, "source")),
      }, { forceDurable: flags.durable === true }), flags);
      break;
    }
    case "promote": {
      assertFlags(flags, ["type", "id", "title", "status", "project", "tags", "summary", "body-file", "body", "confidence", "evidence", "human"]);
      const status = optionalFlag(flags, "status");
      if (status !== undefined && status !== "active" && status !== "done") throw new Error(`Invalid promotion status '${status}'.`);
      out(store.promote(oneArgument(args, cmd), {
        id: optionalFlag(flags, "id"),
        type: durableType(requiredFlag(flags, "type")),
        title: optionalFlag(flags, "title"),
        status,
        project: optionalFlag(flags, "project"),
        tags: csv(optionalFlag(flags, "tags")),
        summary: optionalFlag(flags, "summary"),
        body: body(flags),
        confidence: confidence(optionalFlag(flags, "confidence")),
        evidence: csv(optionalFlag(flags, "evidence")),
      }), flags);
      break;
    }
    case "close":
      assertFlags(flags, ["status", "human"]); out(store.close(oneArgument(args, cmd), optionalFlag(flags, "status") ?? "closed"), flags); break;
    case "supersede":
      assertFlags(flags, ["human"]);
      if (args.length !== 2 || args.some((arg) => !arg.trim())) throw new Error("supersede requires oldId and newId.");
      out(store.supersede(args[0], args[1]), flags); break;
    case "purge-candidates": {
      assertFlags(flags, ["stale-days", "human"]); noArguments(args, cmd);
      const value = optionalFlag(flags, "stale-days");
      out(store.purgeCandidates(value === undefined ? 14 : strictInteger(value, "stale-days", 36_500)), flags); break;
    }
    case "maintain": {
      assertFlags(flags, ["stale-days", "human"]); noArguments(args, cmd);
      const value = optionalFlag(flags, "stale-days");
      out(store.maintain(value === undefined ? 14 : strictInteger(value, "stale-days", 36_500)), flags); break;
    }
    case "archive":
      assertFlags(flags, ["human"]); out(store.archive(oneArgument(args, cmd)), flags); break;
    case "restore":
      assertFlags(flags, ["status", "human"]); out(store.restore(oneArgument(args, cmd), requiredFlag(flags, "status")), flags); break;
    case "verify":
      assertFlags(flags, ["date", "human"]); out(store.verify(oneArgument(args, cmd), requiredFlag(flags, "date")), flags); break;
    case "backup":
      assertFlags(flags, ["output", "human"]); noArguments(args, cmd); out(await store.backup(optionalFlag(flags, "output")), flags); break;
    case "prune": {
      assertFlags(flags, ["apply", "backup", "human"]); noArguments(args, cmd);
      if (flags.apply === undefined) {
        if (flags.backup !== undefined) throw new Error("--backup is only accepted with --apply.");
        out(store.prune(), flags);
      } else {
        if (flags.apply !== true) throw new Error("--apply does not accept a value.");
        out(store.prune({ apply: true, backupPath: requiredFlag(flags, "backup") }), flags);
      }
      break;
    }
    case "status":
      assertFlags(flags, ["human"]); noArguments(args, cmd); out(store.status(), flags); break;
    case "help":
      assertFlags(flags, []); noArguments(args, cmd); console.log(usage()); break;
    default:
      console.error(usage()); process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  store?.dispose();
}
