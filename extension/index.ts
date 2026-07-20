import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatHitsToon } from "/var/home/marcin/Repo/agent-kb/src/format.ts";
import { createStore } from "/var/home/marcin/Repo/agent-kb/src/store.ts";
import type { KbRecord } from "/var/home/marcin/Repo/agent-kb/src/types.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean };

function ok(title: string, details: unknown, textBody?: string): ToolResult {
  const body = textBody ?? JSON.stringify(details, null, 2);
  return { content: [{ type: "text", text: `${title}

${body}` }], details };
}
function fail(message: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text: message }], details, isError: true };
}
function withStore<T>(fn: (store: ReturnType<typeof createStore>) => T): T {
  const store = createStore();
  try { return fn(store); } finally { store.dispose(); }
}

const SearchParams = Type.Object({
  query: Type.String({ default: "" }),
  type: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
});
const GetParams = Type.Object({ id: Type.String() });
const UpsertParams = Type.Object({
  id: Type.String(),
  type: Type.String(),
  title: Type.String(),
  status: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  summary: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.Array(Type.String())),
  source: Type.Optional(Type.String()),
  forceDurable: Type.Optional(Type.Boolean()),
});
const PromoteParams = Type.Object({
  proposalId: Type.String(),
  id: Type.Optional(Type.String()),
  type: Type.String(),
  title: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  summary: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.Array(Type.String())),
  last_verified_at: Type.Optional(Type.String()),
});
const CloseParams = Type.Object({ id: Type.String(), status: Type.Optional(Type.String()) });
const SupersedeParams = Type.Object({ oldId: Type.String(), newId: Type.String() });
const PurgeParams = Type.Object({ staleDays: Type.Optional(Type.Number()) });
const StatusParams = Type.Object({});

export default function agentKbExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "kb_search",
    label: "KB Search",
    description: "Search local typed agent-KB records. Returns compact TOON hit rows (id/type/status/project/confidence/title/summary). Use kb_get for full body/evidence.",
    promptSnippet: "Search agent-KB records by query and filters",
    promptGuidelines: [
      "Prefer kb_search/kb_get before hindsight_recall for durable operational knowledge (Phase 3: Hindsight is legacy/emergency only).",
      "Always cite agent-KB record ids when using recalled facts.",
      "kb_search returns TOON tabular hits without body; call kb_get for full records.",
    ],
    parameters: SearchParams,
    async execute(_id, params) {
      try {
        const hits = withStore((s) => s.search(params.query ?? "", params)) as KbRecord[];
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
      try { return ok("## agent-KB upsert OK", withStore((s) => s.upsert(params as any, { forceDurable: Boolean(params.forceDurable) }))); }
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
      try { return ok("## agent-KB promote OK", withStore((s) => s.promote(params.proposalId, params as any))); }
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
