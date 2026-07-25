import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateAssembleInput } from "/var/home/marcin/Repo/agent-kb/src/assembler.ts";
import { formatHitsToon } from "/var/home/marcin/Repo/agent-kb/src/format.ts";
import { gitPreflightAssemble } from "/var/home/marcin/Repo/agent-kb/src/git-prepush-verifier.ts";
import { createStore, type KbStore } from "/var/home/marcin/Repo/agent-kb/src/store.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean };

function ok(title: string, details: unknown, textBody?: string): ToolResult {
  const body = textBody ?? JSON.stringify(details, null, 2);
  return { content: [{ type: "text", text: `${title}

${body}` }], details };
}
function fail(message: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text: message }], details, isError: true };
}
function withStore<T>(fn: (store: KbStore) => T): T {
  const store = createStore();
  try { return fn(store); } finally { store.dispose(); }
}

function rejectUnknownParams(value: object, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${name} field '${key}'.`);
  }
}

function rejectDualEvidence(value: { evidence?: readonly string[]; evidence_items?: readonly unknown[] }): void {
  if (value.evidence !== undefined && value.evidence_items !== undefined) {
    throw new Error("Use only one of evidence and evidence_items.");
  }
}

const strict = { additionalProperties: false } as const;
const boundedString = (maximum = 2_000) => Type.String({ minLength: 1, maxLength: maximum });
const nullableTimestamp = Type.Union([boundedString(32), Type.Null()]);
const SearchParams = Type.Object({
  query: Type.String({ default: "", maxLength: 2_000 }),
  type: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  explain: Type.Optional(Type.Boolean({ default: false })),
}, strict);
const GetParams = Type.Object({ id: boundedString(256) }, strict);
const RecordTypeParam = Type.Union([
  Type.Literal("handoff"), Type.Literal("decision"), Type.Literal("procedure"),
  Type.Literal("troubleshoot"), Type.Literal("landscape"), Type.Literal("preference"),
  Type.Literal("proposal"),
]);
const DurableTypeParam = Type.Union([
  Type.Literal("decision"), Type.Literal("procedure"), Type.Literal("troubleshoot"),
  Type.Literal("landscape"), Type.Literal("preference"),
]);
const ConfidenceParam = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);
const SourceParam = Type.Union([
  Type.Literal("user"), Type.Literal("agent_promoted"), Type.Literal("import"), Type.Literal("agent"),
]);
const AssertionBasisParam = Type.Union([Type.Literal("asserted"), Type.Literal("inferred"), Type.Null()]);
const SnapshotEvidenceParam = Type.Object({
  kind: Type.Literal("snapshot"),
  uri: boundedString(2_000),
  observed_at: boundedString(32),
  sha256: Type.String({ pattern: "^[0-9a-fA-F]{64}$" }),
}, strict);
const LiveEvidenceParam = Type.Object({
  kind: Type.Literal("live"),
  uri: boundedString(2_000),
  checked_at: Type.Optional(boundedString(32)),
}, strict);
const PointerEvidenceParam = Type.Object({
  kind: Type.Literal("pointer"),
  uri: boundedString(2_000),
}, strict);
const EvidenceItemParam = Type.Union([SnapshotEvidenceParam, LiveEvidenceParam, PointerEvidenceParam]);
const CanonicalSnippetParam = Type.Object({
  id: boundedString(256),
  text: boundedString(4_000),
  verified_at: boundedString(32),
}, strict);
const LimitsParam = Type.Object({
  max_memory_records: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  max_canonical_snippets: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  max_context_chars: Type.Optional(Type.Integer({ minimum: 36, maximum: 6_000 })),
}, strict);
const RiskLevelParam = Type.Union([
  Type.Literal("R0"), Type.Literal("R1"), Type.Literal("R2"), Type.Literal("R3"),
]);
const UpsertParams = Type.Object({
  id: boundedString(256),
  type: RecordTypeParam,
  title: boundedString(),
  status: Type.Optional(boundedString(64)),
  project: Type.Optional(Type.Union([boundedString(256), Type.Null()])),
  tags: Type.Optional(Type.Array(boundedString(256), { maxItems: 100 })),
  summary: Type.Optional(Type.String({ maxLength: 20_000 })),
  body: Type.Optional(Type.String({ maxLength: 100_000 })),
  confidence: Type.Optional(ConfidenceParam),
  evidence: Type.Optional(Type.Array(boundedString(2_000), { maxItems: 100 })),
  evidence_items: Type.Optional(Type.Array(EvidenceItemParam, { maxItems: 100 })),
  assertion_basis: Type.Optional(AssertionBasisParam),
  as_of: Type.Optional(nullableTimestamp),
  expires_at: Type.Optional(nullableTimestamp),
  canonical_ids: Type.Optional(Type.Array(boundedString(256), { maxItems: 100 })),
  source: Type.Optional(SourceParam),
  forceDurable: Type.Optional(Type.Boolean()),
}, strict);
const PromoteParams = Type.Object({
  proposalId: boundedString(256),
  id: Type.Optional(boundedString(256)),
  type: DurableTypeParam,
  title: Type.Optional(boundedString()),
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("done")])),
  project: Type.Optional(Type.Union([boundedString(256), Type.Null()])),
  tags: Type.Optional(Type.Array(boundedString(256), { maxItems: 100 })),
  summary: Type.Optional(Type.String({ maxLength: 20_000 })),
  body: Type.Optional(Type.String({ maxLength: 100_000 })),
  confidence: Type.Optional(ConfidenceParam),
  evidence: Type.Optional(Type.Array(boundedString(2_000), { maxItems: 100 })),
  evidence_items: Type.Optional(Type.Array(EvidenceItemParam, { maxItems: 100 })),
  assertion_basis: Type.Optional(AssertionBasisParam),
  as_of: Type.Optional(nullableTimestamp),
  expires_at: Type.Optional(nullableTimestamp),
  canonical_ids: Type.Optional(Type.Array(boundedString(256), { maxItems: 100 })),
  last_verified_at: Type.Optional(Type.Union([boundedString(32), Type.Null()])),
}, strict);
const AssembleParams = Type.Object({
  query: boundedString(),
  risk_level: RiskLevelParam,
  canonical_snippets: Type.Optional(Type.Array(CanonicalSnippetParam, { maxItems: 3 })),
  limits: Type.Optional(LimitsParam),
}, strict);
const GitPreflightAssembleParams = Type.Object({
  branch: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$" }),
  expected_head: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  query: boundedString(),
  risk_level: RiskLevelParam,
  canonical_snippets: Type.Optional(Type.Array(CanonicalSnippetParam, { maxItems: 3 })),
  limits: Type.Optional(LimitsParam),
}, strict);
const CloseParams = Type.Object({ id: boundedString(256), status: Type.Optional(Type.String()) }, strict);
const SupersedeParams = Type.Object({ oldId: boundedString(256), newId: boundedString(256) }, strict);
const PurgeParams = Type.Object({ staleDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })) }, strict);
const MaintainParams = Type.Object({ staleDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })) }, strict);
const ArchiveParams = Type.Object({ id: boundedString(256) }, strict);
const RestoreParams = Type.Object({ id: boundedString(256), status: Type.String() }, strict);
const StatusParams = Type.Object({}, strict);

export default function agentKbExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "kb_search",
    label: "KB Search",
    description: "Search local typed agent-KB records. Returns compact TOON hit rows by default; explain=true returns bounded JSON ranking diagnostics without body/evidence.",
    promptSnippet: "Search agent-KB records by query and filters",
    promptGuidelines: [
      "Prefer kb_search/kb_get before hindsight_recall for durable operational knowledge (Phase 5: Hindsight is frozen and legacy/emergency only).",
      "Always cite agent-KB record ids when using recalled facts.",
      "kb_search returns TOON tabular hits without body; call kb_get for full records.",
      "Set explain=true only when auditing ranking; default search stays compact.",
    ],
    parameters: SearchParams,
    async execute(_id, params) {
      try {
        const { explain = false, query = "", ...filters } = params;
        if (explain) {
          const diagnostics = withStore((s) => s.searchWithDiagnostics(query, filters));
          return ok("## agent-KB search diagnostics", diagnostics);
        }
        const hits = withStore((s) => s.search(query, filters));
        return ok("## agent-KB search", hits, formatHitsToon(hits));
      } catch (err) { return fail(`agent-KB search failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_get",
    label: "KB Get",
    description: "Get one local agent-KB record by id. Always cite ids when using recalled records.",
    promptSnippet: "Get one agent-KB record by id",
    parameters: GetParams,
    async execute(_id, params) {
      try {
        const rec = withStore((s) => s.get(params.id));
        return rec ? ok("## agent-KB record", rec) : fail(`agent-KB record not found: ${params.id}`);
      } catch (err) { return fail(`agent-KB get failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_assemble",
    label: "KB Assemble Troubleshooting Context",
    description: "Assemble bounded troubleshooting context and an explicit R0-R3 risk gate. This generic tool cannot supply live-verification record ids.",
    promptSnippet: "Assemble bounded operational troubleshooting context",
    promptGuidelines: [
      "Use kb_assemble only for operational troubleshooting that may influence state; normal recall remains kb_search then kb_get.",
      "Run the first pass without invented evidence. The public tool never accepts receipts or live_verified_record_ids, so mutable or stale R2/R3 records remain blocked.",
      "For R2/R3, gate.allowed=true is necessary but never authorization. External-write and domain approval remain independent and must still be enforced.",
    ],
    parameters: AssembleParams,
    async execute(_id, params) {
      try {
        rejectUnknownParams(params, ["query", "risk_level", "canonical_snippets", "limits"], "assemble");
        const input = validateAssembleInput({
          query: params.query,
          risk_class: params.risk_level,
          now: new Date().toISOString(),
          canonical_snippets: params.canonical_snippets ?? [],
          live_verified_record_ids: [],
          limits: params.limits,
        });
        return ok("## agent-KB assembled troubleshooting context", withStore((s) => s.assemble(input)));
      } catch (err) { return fail(`agent-KB assemble failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_git_preflight_assemble",
    label: "KB Git Preflight Assemble",
    description: "Read-only same-task Git pre-push verification for the approved agent-kb origin and fixed troubleshoot:git-prepush-canary record, immediately projected into bounded troubleshooting assembly. It never pushes or authorizes a push.",
    promptSnippet: "Verify approved Git pre-push state and assemble troubleshooting context",
    promptGuidelines: [
      "Use only when the approved agent-kb Git pre-push state is relevant and a separately authorized read-only remote query is allowed.",
      "Never invent or supply a record id, receipt, or live_verified_record_ids; this wrapper verifies the fixed canary record binding and projects only that id.",
      "A successful R2/R3 gate is necessary but never push authorization. External-write and domain approval remain independent.",
    ],
    parameters: GitPreflightAssembleParams,
    async execute(_id, params) {
      try {
        rejectUnknownParams(params, [
          "branch", "expected_head", "query", "risk_level", "canonical_snippets", "limits",
        ], "Git preflight assemble");
        const result = withStore((s) => gitPreflightAssemble(s, params));
        return result.assembly === null
          ? fail(`agent-KB Git preflight blocked: ${result.verifier.code}`, result)
          : ok("## agent-KB Git preflight assembled context", result);
      } catch (err) { return fail(`agent-KB Git preflight failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_upsert",
    label: "KB Upsert",
    description: "Create or update handoff/proposal records; durable new records require forceDurable and should normally be created via kb_promote.",
    promptSnippet: "Upsert an agent-KB handoff or proposal",
    promptGuidelines: [
      "Use kb_upsert for open handoffs and proposals; do not use hindsight_retain for normal capture (Phase 5).",
      "New durable types should be proposals then kb_promote, not forceDurable, unless the user is directly authoring durable records.",
    ],
    parameters: UpsertParams,
    async execute(_id, params) {
      try {
        rejectUnknownParams(params, [
          "id", "type", "title", "status", "project", "tags", "summary", "body", "confidence", "evidence",
          "evidence_items", "assertion_basis", "as_of", "expires_at", "canonical_ids", "source", "forceDurable",
        ], "upsert");
        rejectDualEvidence(params);
        return ok("## agent-KB upsert OK", withStore((s) => s.upsert(params, { forceDurable: Boolean(params.forceDurable) })));
      } catch (err) { return fail(`agent-KB upsert failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_promote",
    label: "KB Promote",
    description: "Promote a proposal into a durable active record: decision, procedure, troubleshoot, landscape, or preference.",
    promptSnippet: "Promote an agent-KB proposal to durable knowledge",
    promptGuidelines: [
      "Use kb_promote as the default path for new durable agent knowledge (Phase 5: no Hindsight capture).",
      "Do not call hindsight_retain after promote.",
    ],
    parameters: PromoteParams,
    async execute(_id, params) {
      try {
        rejectUnknownParams(params, [
          "proposalId", "id", "type", "title", "status", "project", "tags", "summary", "body", "confidence",
          "evidence", "evidence_items", "assertion_basis", "as_of", "expires_at", "canonical_ids", "last_verified_at",
        ], "promote");
        rejectDualEvidence(params);
        return ok("## agent-KB promote OK", withStore((s) => s.promote(params.proposalId, params)));
      } catch (err) { return fail(`agent-KB promote failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_close",
    label: "KB Close Handoff",
    description: "Close or archive a handoff record.",
    promptSnippet: "Close an agent-KB handoff",
    parameters: CloseParams,
    async execute(_id, params) {
      try { return ok("## agent-KB close OK", withStore((s) => s.close(params.id, params.status ?? "closed"))); }
      catch (err) { return fail(`agent-KB close failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_supersede",
    label: "KB Supersede",
    description: "Mark one record superseded/deprecated/archived by a newer record and link the replacement id.",
    promptSnippet: "Supersede one agent-KB record with another",
    parameters: SupersedeParams,
    async execute(_id, params) {
      try { return ok("## agent-KB supersede OK", withStore((s) => s.supersede(params.oldId, params.newId))); }
      catch (err) { return fail(`agent-KB supersede failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_maintain",
    label: "KB Maintenance Report",
    description: "Read-only categorized lifecycle, verification, linkage, database-size, and quick-check report. Never returns record bodies.",
    promptSnippet: "Review agent-KB maintenance categories",
    parameters: MaintainParams,
    async execute(_id, params) {
      try { return ok("## agent-KB maintenance report", withStore((s) => s.maintain(params.staleDays ?? 14))); }
      catch (err) { return fail(`agent-KB maintain failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_archive",
    label: "KB Archive Terminal Record",
    description: "Reversibly archive one terminal record. Active/open/blocked and active durable records are refused.",
    promptSnippet: "Archive a terminal agent-KB record",
    parameters: ArchiveParams,
    async execute(_id, params) {
      try { return ok("## agent-KB archive OK", withStore((s) => s.archive(params.id))); }
      catch (err) { return fail(`agent-KB archive failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_restore",
    label: "KB Restore Archived Record",
    description: "Restore one archived record to a status allowed by its record type.",
    promptSnippet: "Restore an archived agent-KB record",
    parameters: RestoreParams,
    async execute(_id, params) {
      try { return ok("## agent-KB restore OK", withStore((s) => s.restore(params.id, params.status))); }
      catch (err) { return fail(`agent-KB restore failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_purge_candidates",
    label: "KB Purge Candidates",
    description: "List stale or terminal-status records that may be candidates for review; does not delete.",
    promptSnippet: "List agent-KB purge candidates",
    parameters: PurgeParams,
    async execute(_id, params) {
      try { return ok("## agent-KB purge candidates", withStore((s) => s.purgeCandidates(params.staleDays ?? 14))); }
      catch (err) { return fail(`agent-KB purge-candidates failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_status",
    label: "KB Status",
    description: "Show agent-KB database path and counts by type/status.",
    promptSnippet: "Show agent-KB path and counts",
    parameters: StatusParams,
    async execute() {
      try { return ok("## agent-KB status", withStore((s) => s.status())); }
      catch (err) { return fail(`agent-KB status failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
}
