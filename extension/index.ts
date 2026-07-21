import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatHitsToon } from "/var/home/marcin/Repo/agent-kb/src/format.ts";
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

const SearchParams = Type.Object({
  query: Type.String({ default: "" }),
  type: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  explain: Type.Optional(Type.Boolean({ default: false })),
});
const GetParams = Type.Object({ id: Type.String() });
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
const UpsertParams = Type.Object({
  id: Type.String(),
  type: RecordTypeParam,
  title: Type.String(),
  status: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  summary: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  confidence: Type.Optional(ConfidenceParam),
  evidence: Type.Optional(Type.Array(Type.String())),
  source: Type.Optional(SourceParam),
  forceDurable: Type.Optional(Type.Boolean()),
});
const PromoteParams = Type.Object({
  proposalId: Type.String(),
  id: Type.Optional(Type.String()),
  type: DurableTypeParam,
  title: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("done")])),
  project: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  summary: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  confidence: Type.Optional(ConfidenceParam),
  evidence: Type.Optional(Type.Array(Type.String())),
  last_verified_at: Type.Optional(Type.String()),
});
const CloseParams = Type.Object({ id: Type.String(), status: Type.Optional(Type.String()) });
const SupersedeParams = Type.Object({ oldId: Type.String(), newId: Type.String() });
const PurgeParams = Type.Object({ staleDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })) });
const MaintainParams = Type.Object({ staleDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })) });
const ArchiveParams = Type.Object({ id: Type.String() });
const RestoreParams = Type.Object({ id: Type.String(), status: Type.String() });
const StatusParams = Type.Object({});

export default function agentKbExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "kb_search",
    label: "KB Search",
    description: "Search local typed agent-KB records. Returns compact TOON hit rows by default; explain=true returns bounded JSON ranking diagnostics without body/evidence.",
    promptSnippet: "Search agent-KB records by query and filters",
    promptGuidelines: [
      "Prefer kb_search/kb_get before hindsight_recall for durable operational knowledge (Phase 3: Hindsight is legacy/emergency only).",
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
    name: "kb_upsert",
    label: "KB Upsert",
    description: "Create or update handoff/proposal records; durable new records require forceDurable and should normally be created via kb_promote.",
    promptSnippet: "Upsert an agent-KB handoff or proposal",
    promptGuidelines: [
      "Use kb_upsert for open handoffs and proposals; do not use hindsight_retain for normal capture.",
      "New durable types should be proposals then kb_promote, not forceDurable, unless the user is directly authoring durable records.",
    ],
    parameters: UpsertParams,
    async execute(_id, params) {
      try { return ok("## agent-KB upsert OK", withStore((s) => s.upsert(params, { forceDurable: Boolean(params.forceDurable) }))); }
      catch (err) { return fail(`agent-KB upsert failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
  pi.registerTool({
    name: "kb_promote",
    label: "KB Promote",
    description: "Promote a proposal into a durable active record: decision, procedure, troubleshoot, landscape, or preference.",
    promptSnippet: "Promote an agent-KB proposal to durable knowledge",
    promptGuidelines: [
      "Use kb_promote as the default path for new durable agent knowledge (Phase 3: no hermes capture).",
      "Do not call hindsight_retain after promote unless the user explicitly asks for Hindsight.",
    ],
    parameters: PromoteParams,
    async execute(_id, params) {
      try { return ok("## agent-KB promote OK", withStore((s) => s.promote(params.proposalId, params))); }
      catch (err) { return fail(`agent-KB promote failed: ${err instanceof Error ? err.message : String(err)}`); }
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
