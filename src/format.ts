import type { KbRecord } from "./types.ts";

/** Compact hit fields shown in TOON search results (no body/evidence/timestamps). */
export const HIT_FIELDS = [
  "id",
  "type",
  "status",
  "project",
  "confidence",
  "title",
  "summary",
] as const;

export type HitField = (typeof HIT_FIELDS)[number];

/**
 * Escape a scalar for TOON tabular cells.
 * Quotes when the value contains delimiter/control characters or leading/trailing space.
 */
export function toonCell(value: string | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (s === "") return "";
  // Tabular delimiter is comma; colon is common in ids (type:name) and must stay unquoted.
  const needsQuote =
    /[",\n\r\t]/.test(s) ||
    s.startsWith(" ") ||
    s.endsWith(" ") ||
    s.includes("\\");
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n/g, "\\n").replace(/\n/g, "\\n").replace(/\r/g, "\\n")}"`;
}

function hitValue(rec: KbRecord, field: HitField): string {
  switch (field) {
    case "id":
      return rec.id;
    case "type":
      return rec.type;
    case "status":
      return rec.status;
    case "project":
      return rec.project ?? "";
    case "confidence":
      return rec.confidence;
    case "title":
      return rec.title;
    case "summary":
      return rec.summary;
  }
}

/**
 * Render search hits as TOON tabular array (LLM-oriented, token-efficient).
 * Lossless for the selected hit fields only — not a full record dump.
 */
export function formatHitsToon(records: readonly KbRecord[], name = "hits"): string {
  const fields = HIT_FIELDS;
  const header = `${name}[${records.length}]{${fields.join(",")}}:`;
  if (records.length === 0) return header;
  const rows = records.map((rec) =>
    "  " + fields.map((f) => toonCell(hitValue(rec, f))).join(","),
  );
  return [header, ...rows].join("\n");
}
