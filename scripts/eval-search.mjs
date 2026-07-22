#!/usr/bin/env node
/**
 * Fixture-driven evaluation of the public KbStore.search contract.
 * Every run creates and removes a fresh temporary SQLite database.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const fixturePath = join(import.meta.dirname, "fixtures", "search-eval.json");
const injectFailure = process.argv.includes("--inject-failure");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--inject-failure");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
}

function requireObject(value, context) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value;
}

function requireString(value, context) {
  if (typeof value !== "string") throw new Error(`${context} must be a string.`);
  return value;
}

function requireStringArray(value, context) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${context} must be an array of strings.`);
  }
  return value;
}

function requirePositiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(`${context} must be an integer from 1 to 100.`);
  }
  return value;
}

function parseFilters(value, context) {
  const raw = requireObject(value, context);
  const filters = {};
  for (const key of ["type", "status", "project"]) {
    if (raw[key] !== undefined) filters[key] = requireString(raw[key], `${context}.${key}`);
  }
  const unsupported = Object.keys(raw).filter((key) => !["type", "status", "project"].includes(key));
  if (unsupported.length > 0) throw new Error(`${context} has unsupported filter(s): ${unsupported.join(", ")}.`);
  return filters;
}

function parseRankExpectations(value, context) {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value.map((item, index) => {
    const raw = requireObject(item, `${context}[${index}]`);
    return {
      id: requireString(raw.id, `${context}[${index}].id`),
      equals: requirePositiveInteger(raw.equals, `${context}[${index}].equals`),
    };
  });
}

function parseWithinTopN(value, context) {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value.map((item, index) => {
    const raw = requireObject(item, `${context}[${index}]`);
    return {
      id: requireString(raw.id, `${context}[${index}].id`),
      n: requirePositiveInteger(raw.n, `${context}[${index}].n`),
    };
  });
}

function loadFixture() {
  const parsed = requireObject(JSON.parse(readFileSync(fixturePath, "utf8")), "fixture");
  if (!Array.isArray(parsed.records) || !Array.isArray(parsed.cases)) {
    throw new Error("fixture.records and fixture.cases must be arrays.");
  }
  const records = parsed.records.map((value, index) => requireObject(value, `records[${index}]`));
  const cases = parsed.cases.map((value, index) => {
    const raw = requireObject(value, `cases[${index}]`);
    return {
      id: requireString(raw.id, `cases[${index}].id`),
      query: requireString(raw.query, `cases[${index}].query`),
      expectedIds: requireStringArray(raw.expectedIds, `cases[${index}].expectedIds`),
      forbiddenIds: requireStringArray(raw.forbiddenIds, `cases[${index}].forbiddenIds`),
      filters: parseFilters(raw.filters, `cases[${index}].filters`),
      rank: parseRankExpectations(raw.rank, `cases[${index}].rank`),
      withinTopN: parseWithinTopN(raw.withinTopN, `cases[${index}].withinTopN`),
      expectNoResults: raw.expectNoResults === true,
      limit: requirePositiveInteger(raw.limit, `cases[${index}].limit`),
    };
  });
  if (records.length === 0 || cases.length === 0) throw new Error("fixture records and cases must not be empty.");
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("case IDs must be unique.");
  return { records, cases };
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function evaluateCase(store, definition) {
  const hits = store.search(definition.query, { ...definition.filters, limit: definition.limit });
  const resultIds = hits.map((hit) => hit.id);
  const failures = [];

  for (const id of definition.expectedIds) {
    if (!resultIds.includes(id)) failures.push(`expected '${id}' in returned results`);
  }
  const forbiddenHits = definition.forbiddenIds.filter((id) => resultIds.includes(id));
  for (const id of forbiddenHits) failures.push(`forbidden '${id}' appeared in returned results`);
  for (const expectation of definition.rank) {
    const actualRank = resultIds.indexOf(expectation.id) + 1;
    if (actualRank !== expectation.equals) {
      failures.push(`expected '${expectation.id}' at rank ${expectation.equals}, got ${actualRank || "missing"}`);
    }
  }
  for (const expectation of definition.withinTopN) {
    const actualRank = resultIds.indexOf(expectation.id) + 1;
    if (actualRank === 0 || actualRank > expectation.n) {
      failures.push(`expected '${expectation.id}' within top ${expectation.n}, got ${actualRank || "missing"}`);
    }
  }
  if (definition.expectNoResults && resultIds.length !== 0) {
    failures.push(`expected no results, got ${resultIds.length}`);
  }

  return {
    id: definition.id,
    passed: failures.length === 0,
    result_ids: resultIds,
    expected_ids: definition.expectedIds,
    forbidden_hits: forbiddenHits,
    failures,
  };
}

function recallAt(caseDefinitions, caseResults, k) {
  let expectedCount = 0;
  let retrievedCount = 0;
  caseDefinitions.forEach((definition, index) => {
    expectedCount += definition.expectedIds.length;
    const topIds = new Set(caseResults[index].result_ids.slice(0, k));
    retrievedCount += definition.expectedIds.filter((id) => topIds.has(id)).length;
  });
  return expectedCount === 0 ? 1 : retrievedCount / expectedCount;
}

function meanReciprocalRank(caseDefinitions, caseResults) {
  let reciprocalRankSum = 0;
  let relevantCaseCount = 0;
  caseDefinitions.forEach((definition, index) => {
    if (definition.expectedIds.length === 0) return;
    relevantCaseCount += 1;
    const expected = new Set(definition.expectedIds);
    const firstRank = caseResults[index].result_ids.findIndex((id) => expected.has(id)) + 1;
    if (firstRank > 0) reciprocalRankSum += 1 / firstRank;
  });
  return relevantCaseCount === 0 ? 1 : reciprocalRankSum / relevantCaseCount;
}

const tempDirectory = mkdtempSync(join(tmpdir(), "agent-kb-eval-"));
const dbPath = join(tempDirectory, "evaluation.sqlite");
process.env.AGENT_KB_PATH = dbPath;
process.env.HOME = join(tempDirectory, "home");
if (!resolve(process.env.AGENT_KB_PATH).startsWith(`${resolve(tempDirectory)}/`)) throw new Error("Disposable DB escaped test root.");
process.chdir(tempDirectory);
let store;
let report;

try {
  const fixture = loadFixture();
  if (injectFailure) {
    fixture.cases[0] = {
      ...fixture.cases[0],
      expectedIds: ["decision:deliberately-impossible-expectation"],
      rank: [{ id: "decision:deliberately-impossible-expectation", equals: 1 }],
      withinTopN: [{ id: "decision:deliberately-impossible-expectation", n: 1 }],
    };
  }

  const { initializeStore } = await import(pathToFileURL(join(import.meta.dirname, "../src/store.ts")).href)
  store = initializeStore();
  store.init();
  for (const record of fixture.records) store.upsert(record, { forceDurable: true });

  const startedAt = performance.now();
  const caseResults = fixture.cases.map((definition) => evaluateCase(store, definition));
  const elapsedMs = performance.now() - startedAt;
  const passCount = caseResults.filter((result) => result.passed).length;
  const forbiddenHitFailures = caseResults.filter((result) => result.forbidden_hits.length > 0).length;

  report = {
    ok: passCount === caseResults.length,
    injected_failure: injectFailure,
    case_count: caseResults.length,
    pass_count: passCount,
    fail_count: caseResults.length - passCount,
    recall_at_1: rounded(recallAt(fixture.cases, caseResults, 1)),
    recall_at_3: rounded(recallAt(fixture.cases, caseResults, 3)),
    recall_at_5: rounded(recallAt(fixture.cases, caseResults, 5)),
    mean_reciprocal_rank: rounded(meanReciprocalRank(fixture.cases, caseResults)),
    forbidden_hit_failures: forbiddenHitFailures,
    elapsed_ms: rounded(elapsedMs),
    temporary_database: {
      newly_created: true,
      cleaned_up: false,
    },
    cases: caseResults,
  };
} catch (error) {
  report = {
    ok: false,
    injected_failure: injectFailure,
    fatal_error: error instanceof Error ? error.message : String(error),
    temporary_database: {
      newly_created: true,
      cleaned_up: false,
    },
  };
} finally {
  if (store) store.dispose();
  process.chdir(tmpdir());
  rmSync(tempDirectory, { recursive: true, force: true });
  report.temporary_database.cleaned_up = true;
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
