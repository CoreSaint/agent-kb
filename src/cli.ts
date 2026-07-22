#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { formatHitsToon } from "./format.ts";
import { kbPath } from "./db.ts";
import { asKbError, KbError } from "./errors.ts";
import { migrateV1ToV2 } from "./migration.ts";
import { createStore, initializeStore, type KbStore } from "./store.ts";
import {
  confidences,
  durableTypes,
  recordTypes,
  sources,
  type Confidence,
  type DurableType,
  type KbRecord,
  type PromoteInput,
  type RecordType,
  type Source,
  type UpsertInput,
} from "./types.ts";

const CONTRACT_VERSION = "1";
const packageMetadata: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (
  typeof packageMetadata !== "object"
  || packageMetadata === null
  || !("version" in packageMetadata)
  || typeof packageMetadata.version !== "string"
) throw new Error("package.json has no string version.");
const PACKAGE_VERSION = packageMetadata.version;
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
    if (!name || Object.hasOwn(flags, name)) throw new KbError("INVALID_INPUT", `Invalid or duplicate flag '${token}'.`);
    if (eq > 2) flags[name] = token.slice(eq + 1);
    else {
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    }
  }
  return { cmd, args, flags };
}

function assertFlags(flags: Flags, allowed: readonly string[]): void {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) throw new KbError("INVALID_INPUT", `Unknown flag '--${name}'.`);
  }
  for (const name of ["human", "json", "explain", "apply", "durable"]) {
    if (flags[name] !== undefined && flags[name] !== true) throw new KbError("INVALID_INPUT", `--${name} does not accept a value.`);
  }
}

function optionalFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === true) throw new KbError("INVALID_INPUT", `--${name} requires a value.`);
  return value;
}

function requiredFlag(flags: Flags, name: string): string {
  const value = optionalFlag(flags, name);
  if (value === undefined || !value.trim()) throw new KbError("INVALID_INPUT", `--${name} is required.`);
  return value;
}

function oneArgument(args: string[], command: string): string {
  if (args.length !== 1 || !args[0].trim()) throw new KbError("INVALID_INPUT", `${command} requires exactly one id.`);
  return args[0];
}

function noArguments(args: string[], command: string): void {
  if (args.length !== 0) throw new KbError("INVALID_INPUT", `${command} does not accept positional arguments.`);
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new KbError("INVALID_INPUT", "Comma-separated flags require at least one value.");
  return values;
}

function strictInteger(value: string, name: string, maximum: number): number {
  if (!/^[1-9]\d*$/.test(value)) throw new KbError("INVALID_INPUT", `--${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new KbError("INVALID_INPUT", `--${name} must be at most ${maximum}.`);
  return parsed;
}

function enumValue<T extends string>(values: readonly T[], value: unknown, name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new KbError("INVALID_INPUT", `Invalid ${name} '${String(value)}'.`);
  return value as T;
}

function optionalString(value: unknown, name: string, nullable = false): string | null | undefined {
  if (value === undefined) return undefined;
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new KbError("INVALID_INPUT", `${name} must be a string${nullable ? " or null" : ""}.`);
  return value;
}

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new KbError("INVALID_INPUT", `${name} must be an array of strings.`);
  }
  return value;
}

function inputObject(flags: Flags, allowed: readonly string[]): Record<string, unknown> {
  const input = requiredFlag(flags, "input");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(input === "-" ? 0 : input, "utf8"));
  } catch (error) {
    throw new KbError("INVALID_INPUT", `Unable to read valid JSON input from ${input}.`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new KbError("INVALID_INPUT", "JSON input must be an object.");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new KbError("INVALID_INPUT", `Unknown JSON input field '${key}'.`);
  }
  return value as Record<string, unknown>;
}

function jsonUpsert(flags: Flags): { input: UpsertInput; forceDurable: boolean } {
  const value = inputObject(flags, ["id", "type", "title", "status", "project", "tags", "body", "summary", "confidence", "evidence", "source", "durable"]);
  if (typeof value.id !== "string" || !value.id.trim()) throw new KbError("INVALID_INPUT", "id must be a non-empty string.");
  if (typeof value.title !== "string" || !value.title.trim()) throw new KbError("INVALID_INPUT", "title must be a non-empty string.");
  if (value.durable !== undefined && typeof value.durable !== "boolean") throw new KbError("INVALID_INPUT", "durable must be a boolean.");
  return {
    input: {
      id: value.id,
      type: enumValue(recordTypes, value.type, "record type"),
      title: value.title,
      status: optionalString(value.status, "status") as string | undefined,
      project: optionalString(value.project, "project", true),
      tags: stringArray(value.tags, "tags"),
      body: optionalString(value.body, "body") as string | undefined,
      summary: optionalString(value.summary, "summary") as string | undefined,
      confidence: value.confidence === undefined ? undefined : enumValue(confidences, value.confidence, "confidence"),
      evidence: stringArray(value.evidence, "evidence"),
      source: value.source === undefined ? "agent" : enumValue(sources, value.source, "source"),
    },
    forceDurable: value.durable === true,
  };
}

function jsonPromote(flags: Flags): PromoteInput {
  const value = inputObject(flags, ["id", "type", "title", "status", "project", "tags", "body", "summary", "confidence", "evidence", "last_verified_at"]);
  const status = optionalString(value.status, "status");
  if (status !== undefined && status !== "active" && status !== "done") throw new KbError("INVALID_INPUT", `Invalid promotion status '${status}'.`);
  return {
    id: optionalString(value.id, "id") as string | undefined,
    type: enumValue(durableTypes, value.type, "durable type"),
    title: optionalString(value.title, "title") as string | undefined,
    status,
    project: optionalString(value.project, "project", true),
    tags: stringArray(value.tags, "tags"),
    body: optionalString(value.body, "body") as string | undefined,
    summary: optionalString(value.summary, "summary") as string | undefined,
    confidence: value.confidence === undefined ? undefined : enumValue(confidences, value.confidence, "confidence"),
    evidence: stringArray(value.evidence, "evidence"),
    last_verified_at: optionalString(value.last_verified_at, "last_verified_at", true),
  };
}

function legacyBody(flags: Flags): string | undefined {
  const file = optionalFlag(flags, "body-file");
  if (file !== undefined) {
    if (!file.trim() || file.includes("\0")) throw new KbError("INVALID_INPUT", "--body-file must be a non-empty filesystem path.");
    if (flags.body !== undefined) throw new KbError("INVALID_INPUT", "Use only one of --body-file and --body.");
    return readFileSync(file, "utf8");
  }
  return optionalFlag(flags, "body");
}

function success(command: string, data: unknown): void {
  console.log(JSON.stringify({ ok: true, contract_version: CONTRACT_VERSION, command, data }));
}

function human(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function usage(): string {
  return `kb init [--authority-domain UUID] [--json]
kb migrate [--apply] [--json]
kb path [--json]
kb version [--json]
kb contract [--json]
kb search <query> [--type t] [--status s] [--project p] [--limit n] [--json | --explain]
kb get <id> [--json]
kb upsert --input <file|-> [--json]
kb promote <proposalId> --input <file|-> [--json]
kb upsert --id --type --title ... (legacy interactive flags)
kb promote <proposalId> --type durable-type ... (legacy interactive flags)
kb close <id> [--status closed|archived] [--json]
kb supersede <oldId> <newId> [--json]
kb purge-candidates [--stale-days 14] [--json]
kb maintain [--stale-days 14] [--json]
kb archive <id> [--json]
kb restore <id> --status <allowed-status> [--json]
kb verify <id> --date YYYY-MM-DD [--json]
kb backup [--output path] [--json]
kb prune [--apply --backup fresh-maintenance-backup] [--json]
kb status [--json]

Only init creates a database. Without AGENT_KB_PATH, the nearest physical cwd ancestor containing CONTRACT.md and MAP.md uses .agent-kb/kb.sqlite; otherwise the legacy home path is used. Set AGENT_KB_EXPECTED_DOMAIN to bind adapter attachment to an initialized authority-domain UUID.`;
}

const contract = {
  contract_version: CONTRACT_VERSION,
  transport: "JSON CLI over stdout",
  request: "Pass --json for machine envelopes; upsert/promote accept --input <file|->.",
  success: { ok: true, contract_version: "1", command: "<command>", data: "<command result>" },
  error: { ok: false, contract_version: "1", command: "<command>", error: { code: "<stable code>", message: "<message>" } },
  error_codes: ["DB_NOT_INITIALIZED", "DOMAIN_MISMATCH", "NOT_FOUND", "INVALID_INPUT", "INVALID_COMMAND", "SCHEMA_MISMATCH", "MIGRATION_REQUIRED", "CONFLICT", "INTERNAL_FAILURE"],
  exit_codes: { success: 0, contract_error: 2, internal_failure: 1 },
  streams: { success: "one JSON envelope on stdout; stderr empty", error: "one JSON envelope on stdout; stderr empty", interactive_error: "message on stderr" },
  authority_binding: "Set AGENT_KB_EXPECTED_DOMAIN to the UUID returned by init/status.",
  path_resolution: "AGENT_KB_PATH; else nearest physical cwd ancestor with regular CONTRACT.md and MAP.md files; else ~/.local/share/agent-kb/kb.sqlite.",
};

let store: KbStore | undefined;
const rawArgv = process.argv.slice(2);
const requestedCommand = rawArgv[0] ?? "help";
const machine = rawArgv.some((argument) => argument === "--json" || argument.startsWith("--json="));
try {
  const { cmd, args, flags } = parse(rawArgv);
  let data: unknown;
  if (cmd === "help") {
    assertFlags(flags, ["json"]); noArguments(args, cmd); data = usage();
  } else if (cmd === "version") {
    assertFlags(flags, ["json"]); noArguments(args, cmd); data = { version: PACKAGE_VERSION, contract_version: CONTRACT_VERSION };
  } else if (cmd === "contract") {
    assertFlags(flags, ["json"]); noArguments(args, cmd); data = contract;
  } else if (cmd === "path") {
    assertFlags(flags, ["json"]); noArguments(args, cmd); data = { path: kbPath() };
  } else if (cmd === "init") {
    assertFlags(flags, ["authority-domain", "json", "human"]); noArguments(args, cmd);
    store = initializeStore(optionalFlag(flags, "authority-domain"));
    data = store.init();
  } else if (cmd === "migrate") {
    assertFlags(flags, ["apply", "json", "human"]); noArguments(args, cmd);
    data = migrateV1ToV2(kbPath(), flags.apply === true);
  } else {
    const known = ["search", "get", "upsert", "promote", "close", "supersede", "purge-candidates", "maintain", "archive", "restore", "verify", "backup", "prune", "status"];
    if (!known.includes(cmd)) throw new KbError("INVALID_COMMAND", `Unknown command '${cmd}'.`);
    store = createStore();
    switch (cmd) {
      case "search": {
        assertFlags(flags, ["type", "status", "project", "limit", "json", "human", "explain"]);
        if (flags.explain && (flags.json || flags.human)) throw new KbError("INVALID_INPUT", "--explain cannot be combined with --json or --human.");
        const limit = optionalFlag(flags, "limit");
        const filters = { type: optionalFlag(flags, "type"), status: optionalFlag(flags, "status"), project: optionalFlag(flags, "project"), limit: limit === undefined ? 20 : strictInteger(limit, "limit", 100) };
        data = flags.explain ? store.searchWithDiagnostics(args.join(" "), filters) : store.search(args.join(" "), filters);
        if (!machine && !flags.human && !flags.explain) {
          console.log(formatHitsToon(data as KbRecord[]));
          data = undefined;
        }
        break;
      }
      case "get": {
        assertFlags(flags, ["json", "human"]);
        const id = oneArgument(args, cmd);
        data = store.get(id);
        if (!data) throw new KbError("NOT_FOUND", `Record not found: ${id}.`);
        break;
      }
      case "upsert": {
        if (flags.input !== undefined) {
          assertFlags(flags, ["input", "json", "human"]); noArguments(args, cmd);
          const parsed = jsonUpsert(flags);
          data = store.upsert(parsed.input, { forceDurable: parsed.forceDurable });
        } else {
          assertFlags(flags, ["id", "type", "title", "status", "project", "tags", "summary", "body-file", "body", "confidence", "evidence", "source", "durable", "json", "human"]); noArguments(args, cmd);
          data = store.upsert({
            id: requiredFlag(flags, "id"), type: enumValue(recordTypes, requiredFlag(flags, "type"), "record type"), title: requiredFlag(flags, "title"),
            status: optionalFlag(flags, "status"), project: optionalFlag(flags, "project"), tags: csv(optionalFlag(flags, "tags")), summary: optionalFlag(flags, "summary"),
            body: legacyBody(flags), confidence: optionalFlag(flags, "confidence") === undefined ? undefined : enumValue(confidences, optionalFlag(flags, "confidence"), "confidence"),
            evidence: csv(optionalFlag(flags, "evidence")), source: optionalFlag(flags, "source") === undefined ? undefined : enumValue(sources, optionalFlag(flags, "source"), "source"),
          }, { forceDurable: flags.durable === true });
        }
        break;
      }
      case "promote": {
        const sourceId = oneArgument(args, cmd);
        if (flags.input !== undefined) {
          assertFlags(flags, ["input", "json", "human"]);
          data = store.promote(sourceId, jsonPromote(flags));
        } else {
          assertFlags(flags, ["type", "id", "title", "status", "project", "tags", "summary", "body-file", "body", "confidence", "evidence", "json", "human"]);
          const status = optionalFlag(flags, "status");
          if (status !== undefined && status !== "active" && status !== "done") throw new KbError("INVALID_INPUT", `Invalid promotion status '${status}'.`);
          data = store.promote(sourceId, {
            id: optionalFlag(flags, "id"), type: enumValue(durableTypes, requiredFlag(flags, "type"), "durable type"), title: optionalFlag(flags, "title"), status,
            project: optionalFlag(flags, "project"), tags: csv(optionalFlag(flags, "tags")), summary: optionalFlag(flags, "summary"), body: legacyBody(flags),
            confidence: optionalFlag(flags, "confidence") === undefined ? undefined : enumValue(confidences, optionalFlag(flags, "confidence"), "confidence"), evidence: csv(optionalFlag(flags, "evidence")),
          });
        }
        break;
      }
      case "close": assertFlags(flags, ["status", "json", "human"]); data = store.close(oneArgument(args, cmd), optionalFlag(flags, "status") ?? "closed"); break;
      case "supersede": assertFlags(flags, ["json", "human"]); if (args.length !== 2 || args.some((arg) => !arg.trim())) throw new KbError("INVALID_INPUT", "supersede requires oldId and newId."); data = store.supersede(args[0], args[1]); break;
      case "purge-candidates": { assertFlags(flags, ["stale-days", "json", "human"]); noArguments(args, cmd); const value = optionalFlag(flags, "stale-days"); data = store.purgeCandidates(value === undefined ? 14 : strictInteger(value, "stale-days", 36_500)); break; }
      case "maintain": { assertFlags(flags, ["stale-days", "json", "human"]); noArguments(args, cmd); const value = optionalFlag(flags, "stale-days"); data = store.maintain(value === undefined ? 14 : strictInteger(value, "stale-days", 36_500)); break; }
      case "archive": assertFlags(flags, ["json", "human"]); data = store.archive(oneArgument(args, cmd)); break;
      case "restore": assertFlags(flags, ["status", "json", "human"]); data = store.restore(oneArgument(args, cmd), requiredFlag(flags, "status")); break;
      case "verify": assertFlags(flags, ["date", "json", "human"]); data = store.verify(oneArgument(args, cmd), requiredFlag(flags, "date")); break;
      case "backup": assertFlags(flags, ["output", "json", "human"]); noArguments(args, cmd); data = await store.backup(optionalFlag(flags, "output")); break;
      case "prune": {
        assertFlags(flags, ["apply", "backup", "json", "human"]); noArguments(args, cmd);
        if (flags.apply === undefined) { if (flags.backup !== undefined) throw new KbError("INVALID_INPUT", "--backup is only accepted with --apply."); data = store.prune(); }
        else data = store.prune({ apply: true, backupPath: requiredFlag(flags, "backup") });
        break;
      }
      case "status": assertFlags(flags, ["json", "human"]); noArguments(args, cmd); data = store.status(); break;
    }
  }
  if (data !== undefined) {
    if (machine) success(cmd, data);
    else human(data);
  }
} catch (error) {
  const kbError = asKbError(error);
  if (machine) {
    console.log(JSON.stringify({ ok: false, contract_version: CONTRACT_VERSION, command: requestedCommand, error: { code: kbError.code, message: kbError.message } }));
  } else console.error(kbError.message);
  process.exitCode = machine ? (kbError.code === "INTERNAL_FAILURE" ? 1 : 2) : 1;
} finally {
  store?.dispose();
}
