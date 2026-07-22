#!/usr/bin/env node
/**
 * Focused ranking/diagnostics regression coverage on a disposable SQLite database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "agent-kb-diagnostics-"));
const databasePath = join(directory, "test.sqlite");
process.env.AGENT_KB_PATH = databasePath;
process.env.HOME = join(directory, "home");
if (!resolve(process.env.AGENT_KB_PATH).startsWith(`${resolve(directory)}/`)) throw new Error("Disposable DB escaped test root.");
process.chdir(directory);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli(arguments_) {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, AGENT_KB_PATH: databasePath },
  });
  assert(result.status === 0, `CLI failed (${arguments_.join(" ")}): ${result.stderr}`);
  return result.stdout;
}

let store;
let report;
try {
  const { initializeStore } = await import(pathToFileURL(join(import.meta.dirname, "../src/store.ts")).href)
  store = initializeStore();
  store.init();

  const seed = [
    {
      id: "proposal:alpha-beta-gamma-delta",
      type: "proposal",
      title: "Alpha beta gamma delta runbook",
      status: "promoted",
      project: "ranking-lab",
      tags: ["alpha", "beta", "gamma", "delta"],
      summary: "Alpha beta gamma delta exact operational sequence.",
      body: "Follow alpha beta gamma delta in order.",
      confidence: "low",
      source: "agent",
    },
    {
      id: "decision:alpha-favorable-metadata",
      type: "decision",
      title: "Alpha operational guide",
      status: "active",
      project: "ranking-lab",
      tags: ["alpha"],
      summary: "Alpha overview without the remaining requested terms.",
      body: "General alpha guidance.",
      confidence: "high",
      last_verified_at: "2026-07-21",
      source: "user",
    },
    {
      id: "proposal:quartz-identical-twin",
      type: "proposal",
      title: "Quartz identical cache policy",
      status: "promoted",
      project: "ranking-lab",
      tags: ["quartz", "cache", "policy"],
      summary: "Quartz cache policy uses a twelve hour retention window.",
      body: "Keep Quartz cache entries for twelve hours.",
      confidence: "high",
      source: "agent",
    },
    {
      id: "decision:quartz-identical-twin",
      type: "decision",
      title: "Quartz identical cache policy",
      status: "active",
      project: "ranking-lab",
      tags: ["quartz", "cache", "policy"],
      summary: "Quartz cache policy uses a twelve hour retention window.",
      body: "Keep Quartz cache entries for twelve hours.",
      confidence: "high",
      last_verified_at: "2026-07-21",
      source: "agent_promoted",
    },
    {
      id: "decision:quartz-superseded-policy",
      type: "decision",
      title: "Quartz identical cache policy",
      status: "superseded",
      project: "ranking-lab",
      tags: ["quartz", "cache", "policy"],
      summary: "Superseded Quartz cache policy retained for discovery.",
      body: "Old Quartz cache policy retained for historical lookup.",
      confidence: "medium",
      source: "user",
    },
    {
      id: "procedure:retired-quartz-cache",
      type: "procedure",
      title: "Retired Quartz cache policy",
      status: "deprecated",
      project: "ranking-lab",
      tags: ["quartz", "cache", "policy"],
      summary: "Deprecated Quartz cache instructions retained for discovery.",
      body: "Old Quartz cache policy retained for historical lookup.",
      confidence: "medium",
      source: "user",
    },
  ];
  for (const record of seed) store.upsert(record, { forceDurable: true });

  const adversarial = store.searchWithDiagnostics("alpha beta gamma delta", { project: "ranking-lab" });
  const strongId = "proposal:alpha-beta-gamma-delta";
  const weakId = "decision:alpha-favorable-metadata";
  const strong = adversarial.find((hit) => hit.id === strongId);
  const weak = adversarial.find((hit) => hit.id === weakId);
  assert(strong && weak, "adversarial candidates must both be returned");
  assert(adversarial[0].id === strongId, "materially stronger lexical match must rank first");
  assert(strong.raw_rrf_score > weak.raw_rrf_score, "strong candidate must have greater raw lexical relevance");

  const legacyOrdering = [strong, weak]
    .map((hit) => ({ id: hit.id, score: hit.raw_rrf_score + hit.metadata.raw_total }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  assert(legacyOrdering[0].id === weakId, "legacy additive formula must demonstrate metadata dominance");

  const expectedStrongLists = ["and", "or", "phrase", "title_tags"];
  const actualStrongLists = strong.retrieval_lists.map((item) => item.list).sort();
  assert(JSON.stringify(actualStrongLists) === JSON.stringify(expectedStrongLists), "strong retrieval-list contributions must be complete and accurate");

  for (const hit of adversarial) {
    const contributionSum = hit.retrieval_lists.reduce((sum, item) => sum + item.rrf_contribution, 0);
    assert(Math.abs(contributionSum - hit.raw_rrf_score) < 1e-12, `retrieval contributions must sum to raw RRF for ${hit.id}`);
    const reconstructed = hit.normalized_lexical_score + hit.metadata.bounded_contribution + hit.exact_id_bonus;
    assert(Math.abs(reconstructed - hit.final_score) < 1e-12, `components must reconstruct final score for ${hit.id}`);
    assert(Math.abs(hit.metadata.bounded_contribution) <= 0.05, `metadata bound exceeded for ${hit.id}`);
  }

  const twinQuery = "Quartz identical cache policy";
  const twins = store.searchWithDiagnostics(twinQuery, { project: "ranking-lab" });
  const durableTwin = twins.find((hit) => hit.id === "decision:quartz-identical-twin");
  const proposalTwin = twins.find((hit) => hit.id === "proposal:quartz-identical-twin");
  const supersededTwin = twins.find((hit) => hit.id === "decision:quartz-superseded-policy");
  const deprecatedTwin = twins.find((hit) => hit.id === "procedure:retired-quartz-cache");
  assert(durableTwin && proposalTwin && supersededTwin && deprecatedTwin, "active and terminal records must remain discoverable");
  assert(twins[0].id === durableTwin.id, "metadata must resolve a lexical near-tie for active durable knowledge");
  assert(Math.abs(durableTwin.normalized_lexical_score - proposalTwin.normalized_lexical_score) < 0.05, "twin candidates must be lexical near-ties");
  assert(durableTwin.metadata.bounded_contribution > proposalTwin.metadata.bounded_contribution, "durable twin must receive the better bounded metadata contribution");
  assert(twins.indexOf(proposalTwin) > 0, "promoted twin must be demoted below active durable knowledge");
  assert(twins.indexOf(supersededTwin) > 0, "superseded record must be demoted below active durable knowledge");
  assert(twins.indexOf(deprecatedTwin) > 0, "deprecated record must be demoted below active durable knowledge");

  const promotedOnly = store.searchWithDiagnostics(twinQuery, { status: "promoted", project: "ranking-lab" });
  assert(promotedOnly.length === 1 && promotedOnly[0].id === proposalTwin.id, "explicit status filter must surface promoted records");
  const deprecatedOnly = store.searchWithDiagnostics("retired Quartz cache policy", { status: "deprecated", project: "ranking-lab" });
  assert(deprecatedOnly[0]?.id === "procedure:retired-quartz-cache", "explicit status filter must surface deprecated records");
  const supersededOnly = store.searchWithDiagnostics(twinQuery, { status: "superseded", project: "ranking-lab" });
  assert(supersededOnly.length === 1 && supersededOnly[0].id === supersededTwin.id, "explicit status filter must surface superseded records");

  const exact = store.searchWithDiagnostics(strongId, { project: "ranking-lab" });
  assert(exact[0]?.id === strongId && exact[0].exact_id_match, "exact ID must rank first");
  assert(exact[0].retrieval_lists.some((item) => item.list === "exact_id" && item.rank === 1), "exact-ID retrieval contribution must identify list and rank");
  assert(store.searchWithDiagnostics(strongId, { project: "wrong-project" }).length === 0, "filters must exclude an exact ID");

  const toon = runCli(["search", twinQuery, "--project", "ranking-lab"]);
  assert(toon.startsWith("hits["), "default CLI search must remain TOON");
  assert(!toon.includes("raw_rrf_score") && !toon.includes("body") && !toon.includes("evidence"), "default TOON must not contain diagnostics or full content");

  const fullJsonEnvelope = JSON.parse(runCli(["search", twinQuery, "--project", "ranking-lab", "--json"]));
  const fullJson = fullJsonEnvelope.data;
  assert(fullJsonEnvelope.ok === true && fullJsonEnvelope.contract_version === "1", "--json must use the versioned envelope");
  assert(Array.isArray(fullJson) && typeof fullJson[0]?.body === "string" && Array.isArray(fullJson[0]?.evidence), "--json data must retain full records");
  assert(fullJson[0].raw_rrf_score === undefined, "--json must not add diagnostics");

  const explain = JSON.parse(runCli(["search", twinQuery, "--project", "ranking-lab", "--explain"]));
  assert(Array.isArray(explain) && typeof explain[0]?.raw_rrf_score === "number", "--explain must return diagnostic JSON");
  assert(explain.every((hit) => hit.body === undefined && hit.evidence === undefined), "--explain must exclude body and evidence");

  report = {
    ok: true,
    cases: 11,
    formula_tolerance: 1e-12,
    metadata_bound: 0.05,
    adversarial: {
      legacy_order: legacyOrdering.map((item) => item.id),
      calibrated_order: adversarial.slice(0, 2).map((item) => item.id),
      strong_raw_rrf: strong.raw_rrf_score,
      weak_raw_rrf: weak.raw_rrf_score,
      strong_final_score: strong.final_score,
      weak_final_score: weak.final_score,
    },
    temporary_database_cleaned: false,
  };
} finally {
  if (store) store.dispose();
  process.chdir(tmpdir());
  rmSync(directory, { recursive: true, force: true });
}
report.temporary_database_cleaned = true;
console.log(JSON.stringify(report, null, 2));
