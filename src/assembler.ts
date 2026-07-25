import {
  assertionBases,
  type AssertionBasis,
  type Evidence,
  type KbRecord,
} from "./types.ts";

export const riskClasses = ["R0", "R1", "R2", "R3"] as const;
export type RiskClass = (typeof riskClasses)[number];

export interface CanonicalSnippet {
  id: string;
  text: string;
  verified_at: string;
}

export interface AssembleLimits {
  max_memory_records: number;
  max_canonical_snippets: number;
  max_context_chars: number;
}

export interface AssembleInput {
  query: string;
  risk_class: RiskClass;
  now: string;
  canonical_snippets: CanonicalSnippet[];
  live_verified_record_ids: string[];
  limits: AssembleLimits;
}

export type AuthorityClass = "canonical_or_live" | "active_promoted" | "provisional" | "handoff_or_session";
export type VerificationRequirement = "live" | `canonical:${string}`;

export interface AssembledMemoryItem {
  id: string;
  authority: AuthorityClass;
  assertion_basis: AssertionBasis | null;
  as_of: string | null;
  expires_at: string | null;
  evidence_classes: Array<Evidence["kind"]>;
  stale: boolean;
  canonical_ids: string[];
  conflicts: string[];
  verification_required: VerificationRequirement[];
  text: string;
}

export type GateReasonCode =
  | "live_verification_required"
  | "canonical_verification_missing"
  | "canonical_budget_exceeded"
  | "context_budget_exceeded"
  | "lineage_conflict"
  | "memory_context_omitted";

export interface GateReason {
  code: GateReasonCode;
  record_id?: string;
  canonical_id?: string;
  conflicting_record_id?: string;
}

export interface AssembleResult {
  query: string;
  risk_class: RiskClass;
  now: string;
  stale_boundary: "expires_at <= now";
  items: AssembledMemoryItem[];
  canonical_snippets: CanonicalSnippet[];
  omitted_canonical_ids: string[];
  omitted_memory_ids: string[];
  budget: {
    max_context_chars: number;
    estimated_context_chars: number;
    fits: boolean;
    complete: boolean;
  };
  gate: {
    allowed: boolean;
    reasons: GateReason[];
  };
}

const DEFAULT_LIMITS: AssembleLimits = {
  max_memory_records: 5,
  max_canonical_snippets: 3,
  max_context_chars: 6_000,
};
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const SHA256 = /^[0-9a-f]{64}$/iu;
const EMPTY_CONTEXT_CHARS = JSON.stringify({ items: [], canonical_snippets: [] }).length;

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${name} field '${key}'.`);
  }
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

export function validateTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) throw new Error(`${name} must be an RFC 3339 UTC timestamp.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) throw new Error(`${name} must be a valid timestamp.`);
  return value;
}

function optionalTimestamp(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return validateTimestamp(value, name);
}

export function validateAssertionBasis(value: unknown, name = "assertion_basis"): AssertionBasis | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !assertionBases.some((basis) => basis === value)) {
    throw new Error(`${name} must be asserted, inferred, or null.`);
  }
  return value as AssertionBasis;
}

export function validateCanonicalIds(value: unknown, name = "canonical_ids"): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of non-empty strings.`);
  const ids = value.map((item, index) => nonEmptyString(item, `${name}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${name} must not contain duplicates.`);
  return ids;
}

function validateUri(value: unknown, name: string): string {
  return nonEmptyString(value, name);
}

export function validateEvidenceItems(value: unknown, name = "evidence_items"): Evidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value.map((item, index) => {
    const evidence = objectValue(item, `${name}[${index}]`);
    if (evidence.kind === "snapshot") {
      rejectUnknown(evidence, ["kind", "uri", "observed_at", "sha256"], `${name}[${index}]`);
      const sha256 = nonEmptyString(evidence.sha256, `${name}[${index}].sha256`);
      if (!SHA256.test(sha256)) throw new Error(`${name}[${index}].sha256 must be a 64-character hexadecimal SHA-256 hash.`);
      return {
        kind: "snapshot",
        uri: validateUri(evidence.uri, `${name}[${index}].uri`),
        observed_at: validateTimestamp(evidence.observed_at, `${name}[${index}].observed_at`),
        sha256: sha256.toLowerCase(),
      };
    }
    if (evidence.kind === "live") {
      rejectUnknown(evidence, ["kind", "uri", "checked_at"], `${name}[${index}]`);
      const checkedAt = evidence.checked_at === undefined ? undefined : validateTimestamp(evidence.checked_at, `${name}[${index}].checked_at`);
      return checkedAt === undefined
        ? { kind: "live", uri: validateUri(evidence.uri, `${name}[${index}].uri`) }
        : { kind: "live", uri: validateUri(evidence.uri, `${name}[${index}].uri`), checked_at: checkedAt };
    }
    if (evidence.kind === "pointer") {
      rejectUnknown(evidence, ["kind", "uri"], `${name}[${index}]`);
      return { kind: "pointer", uri: validateUri(evidence.uri, `${name}[${index}].uri`) };
    }
    throw new Error(`${name}[${index}].kind must be snapshot, live, or pointer.`);
  });
}

export function validateTemporalOrder(asOf: string | null, expiresAt: string | null): void {
  if (asOf !== null && expiresAt !== null && Date.parse(expiresAt) < Date.parse(asOf)) {
    throw new Error("expires_at must be greater than or equal to as_of.");
  }
}

function positiveInteger(value: unknown, name: string, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of non-empty strings.`);
  const strings = value.map((item, index) => nonEmptyString(item, `${name}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new Error(`${name} must not contain duplicates.`);
  return strings;
}

export function validateAssembleInput(value: unknown): AssembleInput {
  const input = objectValue(value, "assemble input");
  rejectUnknown(input, ["query", "risk_class", "now", "canonical_snippets", "live_verified_record_ids", "limits"], "assemble input");
  const risk = input.risk_class;
  if (typeof risk !== "string" || !riskClasses.some((candidate) => candidate === risk)) throw new Error(`Invalid risk_class '${String(risk)}'.`);
  const canonicalValue = input.canonical_snippets ?? [];
  if (!Array.isArray(canonicalValue)) throw new Error("canonical_snippets must be an array.");
  const canonicalSnippets = canonicalValue.map((item, index) => {
    const snippet = objectValue(item, `canonical_snippets[${index}]`);
    rejectUnknown(snippet, ["id", "text", "verified_at"], `canonical_snippets[${index}]`);
    return {
      id: nonEmptyString(snippet.id, `canonical_snippets[${index}].id`),
      text: nonEmptyString(snippet.text, `canonical_snippets[${index}].text`),
      verified_at: validateTimestamp(snippet.verified_at, `canonical_snippets[${index}].verified_at`),
    };
  });
  if (new Set(canonicalSnippets.map((snippet) => snippet.id)).size !== canonicalSnippets.length) {
    throw new Error("canonical_snippets must not contain duplicate ids.");
  }
  const limitsValue = input.limits === undefined ? {} : objectValue(input.limits, "limits");
  rejectUnknown(limitsValue, ["max_memory_records", "max_canonical_snippets", "max_context_chars"], "limits");
  const now = input.now === undefined ? new Date().toISOString() : validateTimestamp(input.now, "now");
  for (const snippet of canonicalSnippets) {
    if (Date.parse(snippet.verified_at) > Date.parse(now)) {
      throw new Error(`canonical snippet '${snippet.id}' verified_at must not be later than now.`);
    }
  }
  const maxContextChars = positiveInteger(limitsValue.max_context_chars, "limits.max_context_chars", 6_000, DEFAULT_LIMITS.max_context_chars);
  if (maxContextChars < EMPTY_CONTEXT_CHARS) {
    throw new Error(`limits.max_context_chars must be at least ${EMPTY_CONTEXT_CHARS}.`);
  }
  return {
    query: nonEmptyString(input.query, "query"),
    risk_class: risk as RiskClass,
    now,
    canonical_snippets: canonicalSnippets,
    live_verified_record_ids: stringArray(input.live_verified_record_ids, "live_verified_record_ids"),
    limits: {
      max_memory_records: positiveInteger(limitsValue.max_memory_records, "limits.max_memory_records", 5, DEFAULT_LIMITS.max_memory_records),
      max_canonical_snippets: positiveInteger(limitsValue.max_canonical_snippets, "limits.max_canonical_snippets", 3, DEFAULT_LIMITS.max_canonical_snippets),
      max_context_chars: maxContextChars,
    },
  };
}

function authority(record: KbRecord): AuthorityClass {
  if (record.evidence_items.some((item) => item.kind === "snapshot" || item.kind === "live")) return "canonical_or_live";
  if ((record.status === "active" || record.status === "done") && (record.source === "agent_promoted" || record.promoted_from !== null)) {
    return "active_promoted";
  }
  return "handoff_or_session";
}

const AUTHORITY_WEIGHT: Record<AuthorityClass, number> = {
  canonical_or_live: 3,
  active_promoted: 2,
  provisional: 1,
  handoff_or_session: 0,
};

function packedContextChars(items: readonly AssembledMemoryItem[], canonicalSnippets: readonly CanonicalSnippet[]): number {
  return JSON.stringify({ items, canonical_snippets: canonicalSnippets }).length;
}

export function assembleContext(candidates: readonly KbRecord[], input: AssembleInput): AssembleResult {
  const nowMs = Date.parse(input.now);
  const ranked = candidates
    .map((record, searchRank) => ({ record, searchRank, authority: authority(record) }))
    .sort((left, right) => AUTHORITY_WEIGHT[right.authority] - AUTHORITY_WEIGHT[left.authority] || left.searchRank - right.searchRank)
    .slice(0, input.limits.max_memory_records);
  const presentIds = new Set(ranked.map((candidate) => candidate.record.id));
  const verifiedLiveIds = new Set(input.live_verified_record_ids);
  const candidateItems = ranked.map(({ record, authority: authorityClass }) => {
    const stale = record.expires_at !== null && Date.parse(record.expires_at) <= nowMs;
    const mutable = record.evidence_items.some((evidence) => evidence.kind === "live" || evidence.kind === "pointer");
    const conflicts = record.superseded_by !== null && presentIds.has(record.superseded_by) ? [record.superseded_by] : [];
    const verificationRequired: VerificationRequirement[] = [];
    if ((stale || mutable) && !verifiedLiveIds.has(record.id)) verificationRequired.push("live");
    for (const id of record.canonical_ids) verificationRequired.push(`canonical:${id}`);
    return {
      id: record.id,
      authority: authorityClass,
      assertion_basis: record.assertion_basis,
      as_of: record.as_of,
      expires_at: record.expires_at,
      evidence_classes: [...new Set(record.evidence_items.map((evidence) => evidence.kind))].sort(),
      stale,
      canonical_ids: record.canonical_ids,
      conflicts,
      verification_required: verificationRequired,
      text: record.summary || record.body || record.title,
    };
  });

  const requiredCanonicalIds: string[] = [];
  for (const item of candidateItems) {
    for (const id of item.canonical_ids) if (!requiredCanonicalIds.includes(id)) requiredCanonicalIds.push(id);
  }
  const snippetsById = new Map(input.canonical_snippets.map((snippet) => [snippet.id, snippet]));
  const countEligibleCanonicalIds = requiredCanonicalIds.slice(0, input.limits.max_canonical_snippets);
  const omittedCanonicalIds = requiredCanonicalIds.slice(input.limits.max_canonical_snippets);
  const canonicalSnippets: CanonicalSnippet[] = [];
  let contextOverflow = false;
  for (let index = 0; index < countEligibleCanonicalIds.length; index++) {
    const id = countEligibleCanonicalIds[index];
    const snippet = snippetsById.get(id);
    if (snippet === undefined) {
      if (!omittedCanonicalIds.includes(id)) omittedCanonicalIds.push(id);
      continue;
    }
    if (packedContextChars([], [...canonicalSnippets, snippet]) <= input.limits.max_context_chars) {
      canonicalSnippets.push(snippet);
      continue;
    }
    contextOverflow = true;
    for (const remainingId of countEligibleCanonicalIds.slice(index)) {
      if (!omittedCanonicalIds.includes(remainingId)) omittedCanonicalIds.push(remainingId);
    }
    break;
  }

  const items: AssembledMemoryItem[] = [];
  const omittedMemoryIds: string[] = [];
  if (contextOverflow) {
    omittedMemoryIds.push(...candidateItems.map((item) => item.id));
  } else {
    for (let index = 0; index < candidateItems.length; index++) {
      const item = candidateItems[index];
      if (packedContextChars([...items, item], canonicalSnippets) <= input.limits.max_context_chars) {
        items.push(item);
        continue;
      }
      contextOverflow = true;
      omittedMemoryIds.push(...candidateItems.slice(index).map((remaining) => remaining.id));
      break;
    }
  }

  const estimatedContextChars = packedContextChars(items, canonicalSnippets);
  const reasons: GateReason[] = [];
  for (const item of candidateItems) {
    if (item.verification_required.includes("live")) reasons.push({ code: "live_verification_required", record_id: item.id });
    for (const id of item.canonical_ids) {
      if (!snippetsById.has(id)) reasons.push({ code: "canonical_verification_missing", record_id: item.id, canonical_id: id });
    }
    for (const conflict of item.conflicts) reasons.push({ code: "lineage_conflict", record_id: item.id, conflicting_record_id: conflict });
  }
  if (requiredCanonicalIds.length > input.limits.max_canonical_snippets) {
    reasons.push({ code: "canonical_budget_exceeded", canonical_id: requiredCanonicalIds[input.limits.max_canonical_snippets] });
  }
  for (const id of omittedMemoryIds) reasons.push({ code: "memory_context_omitted", record_id: id });
  if (contextOverflow) reasons.push({ code: "context_budget_exceeded" });
  const failClosed = input.risk_class === "R2" || input.risk_class === "R3";
  return {
    query: input.query,
    risk_class: input.risk_class,
    now: input.now,
    stale_boundary: "expires_at <= now",
    items,
    canonical_snippets: canonicalSnippets,
    omitted_canonical_ids: omittedCanonicalIds,
    omitted_memory_ids: omittedMemoryIds,
    budget: {
      max_context_chars: input.limits.max_context_chars,
      estimated_context_chars: estimatedContextChars,
      fits: estimatedContextChars <= input.limits.max_context_chars,
      complete: omittedCanonicalIds.length === 0 && omittedMemoryIds.length === 0,
    },
    gate: { allowed: !failClosed || reasons.length === 0, reasons },
  };
}
