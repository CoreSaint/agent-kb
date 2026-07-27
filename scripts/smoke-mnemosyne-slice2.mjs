#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initDb } from "../src/db.ts";
import {
  buildGitRunnerEnvironment,
  DEFAULT_GIT_PREPUSH_POLICY,
  GIT_PREPUSH_CANARY_RECORD_ID,
  gitPreflightAssemble,
  gitReadCommandArgs,
  sanitizeGitCommandResult,
  validateGitPrepushReceipt,
  verifyGitPrepush,
} from "../src/git-prepush-verifier.ts";
import { KbStore } from "../src/store.ts";
const piRoot = resolve(realpathSync("/home/linuxbrew/.linuxbrew/bin/pi"), "..", "..");
const piModules = join(piRoot, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(pathToFileURL(join(piModules, "dist/core/extensions/loader.js")).href);
const { Value } = await import(pathToFileURL(join(piModules, "node_modules/typebox/build/value/index.mjs")).href);

process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "agent-kb-mnemosyne-slice2-"));
const database = join(root, "slice2.sqlite");
const home = join(root, "home");
const extensionPath = resolve(import.meta.dirname, "../extension/index.ts");
const liveDatabase = "/var/home/marcin/vaults/work/.agent-kb/kb.sqlite";
const repo = DEFAULT_GIT_PREPUSH_POLICY.repo_realpath;
const branch = "feat/mnemosyne-slice2-wire-feed";
const localHead = "a".repeat(40);
const remoteHead = "b".repeat(40);
const recordId = GIT_PREPUSH_CANARY_RECORD_ID;
const checkedAt = new Date("2026-07-25T12:00:00.000Z");
const later = new Date("2026-07-25T12:00:30.000Z");
const canonical = [{ id: "canon:git-prepush", text: "Approved repository and origin policy.", verified_at: checkedAt.toISOString() }];

assert.ok(resolve(database).startsWith(`${resolve(root)}/`));
assert.notEqual(resolve(database), liveDatabase);
process.env.HOME = home;
process.env.AGENT_KB_PATH = database;
delete process.env.AGENT_KB_EXPECTED_DOMAIN;

function fixture(overrides = {}) {
  const commands = [];
  const counts = new Map();
  const runner = (command) => {
    commands.push(command);
    const occurrence = (counts.get(command.kind) ?? 0) + 1;
    counts.set(command.kind, occurrence);
    if (overrides.commandFailure === command.kind && (overrides.commandFailurePass ?? 1) === occurrence) {
      return { status: 128, stdout: "" };
    }
    switch (command.kind) {
      case "repository_root": {
        const value = occurrence === 2 ? overrides.secondRoot ?? overrides.root ?? repo : overrides.root ?? repo;
        return { status: 0, stdout: `${value}\n` };
      }
      case "branch": {
        const value = occurrence === 2 ? overrides.secondBranch ?? overrides.branch ?? branch : overrides.branch ?? branch;
        return { status: 0, stdout: `${value}\n` };
      }
      case "head": {
        const value = occurrence === 2 ? overrides.secondHead ?? overrides.localHead ?? localHead : overrides.localHead ?? localHead;
        return { status: 0, stdout: `${value}\n` };
      }
      case "status": {
        const dirty = occurrence === 2 ? overrides.secondDirty ?? overrides.dirty : overrides.dirty;
        return { status: 0, stdout: dirty ? " M src/store.ts\n" : "" };
      }
      case "remote_url": {
        const initial = overrides.remoteUrl ?? "https://github.com/CoreSaint/agent-kb.git";
        const value = occurrence === 2 ? overrides.secondRemoteUrl ?? initial : initial;
        return { status: 0, stdout: `${value}\n` };
      }
      case "remote_ref": {
        const initialRef = overrides.remoteRef ?? `refs/heads/${branch}`;
        const initialHead = overrides.remoteHead ?? remoteHead;
        const ref = occurrence === 2 ? overrides.secondRemoteRef ?? initialRef : initialRef;
        const sha = occurrence === 2 ? overrides.secondRemoteHead ?? initialHead : initialHead;
        return { status: 0, stdout: overrides.malformedRemote ? "malformed\n" : `${sha}\t${ref}\n` };
      }
      case "local_object": return { status: overrides.missingObject ? 1 : 0, stdout: "" };
      case "ancestry": return { status: overrides.nonAncestor ? 1 : 0, stdout: "" };
    }
  };
  return { commands, runner };
}

function request(expectedHead = localHead) {
  return { record_id: recordId, branch, expected_head: expectedHead };
}

function expectFailure(overrides, code, customRequest = request()) {
  const setup = fixture(overrides);
  const result = verifyGitPrepush(customRequest, setup.runner, DEFAULT_GIT_PREPUSH_POLICY, checkedAt);
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  return { result, commands: setup.commands };
}

function expectCanaryFailure(name, record, code) {
  const path = join(root, `${name}.sqlite`);
  assert.notEqual(resolve(path), liveDatabase);
  const initialized = initDb(path, "99999999-9999-4999-8999-999999999999");
  const isolatedStore = new KbStore(initialized.db, path);
  try {
    if (record !== null) isolatedStore.upsert(record, { forceDurable: true });
    const setup = fixture();
    const result = gitPreflightAssemble(isolatedStore, {
      branch, expected_head: localHead, query: recordId, risk_level: "R2", canonical_snippets: canonical,
    }, { runner: setup.runner, now: () => later });
    assert.equal(result.assembly, null);
    assert.equal(result.verifier.code, code);
    assert.deepEqual(setup.commands, [], "invalid canary binding must block before Git verification");
  } finally {
    isolatedStore.dispose();
  }
}

let report;
try {
  const initialized = initDb(database, "88888888-8888-4888-8888-888888888888");
  const store = new KbStore(initialized.db, database);
  try {
    store.upsert({
      id: recordId,
      type: "troubleshoot",
      title: "Git pre-push canary",
      status: "active",
      summary: "Verify local and approved origin state before considering a push.",
      source: "agent_promoted",
      assertion_basis: "asserted",
      evidence_items: [{ kind: "live", uri: "https://github.com/CoreSaint/agent-kb" }],
      canonical_ids: ["canon:git-prepush"],
    }, { forceDurable: true });

    const firstPass = store.assemble({
      query: recordId,
      risk_class: "R2",
      now: checkedAt.toISOString(),
      canonical_snippets: canonical,
      live_verified_record_ids: [],
      limits: { max_memory_records: 5, max_canonical_snippets: 3, max_context_chars: 6_000 },
    });
    assert.equal(firstPass.gate.allowed, false);
    assert(firstPass.gate.reasons.some((reason) => reason.code === "live_verification_required"));

    for (const risk of ["R0", "R1"]) {
      const bounded = store.assemble({
        query: recordId,
        risk_class: risk,
        now: checkedAt.toISOString(),
        canonical_snippets: [],
        live_verified_record_ids: [],
        limits: { max_memory_records: 1, max_canonical_snippets: 1, max_context_chars: 600 },
      });
      assert.equal(bounded.gate.allowed, true);
      assert(bounded.budget.estimated_context_chars <= bounded.budget.max_context_chars);
    }

    const canaryRecord = (evidenceItems, status = "active") => ({
      id: recordId,
      type: "troubleshoot",
      title: "Git pre-push canary",
      status,
      evidence_items: evidenceItems,
    });
    expectCanaryFailure("canary-missing", null, "canary_record_missing");
    expectCanaryFailure(
      "canary-wrong-record",
      { id: recordId, type: "proposal", title: "Wrong canary type" },
      "canary_record_invalid",
    );
    expectCanaryFailure(
      "canary-no-live-evidence",
      canaryRecord([{ kind: "snapshot", uri: "file:///tmp/git-state", observed_at: checkedAt.toISOString(), sha256: "e".repeat(64) }]),
      "canary_evidence_invalid",
    );
    expectCanaryFailure(
      "canary-wrong-live-evidence",
      canaryRecord([{ kind: "live", uri: "https://example.invalid/unrelated" }]),
      "canary_evidence_invalid",
    );
    expectCanaryFailure(
      "canary-extra-live-evidence",
      canaryRecord([
        { kind: "live", uri: "https://github.com/CoreSaint/agent-kb" },
        { kind: "live", uri: "https://example.invalid/unrelated" },
      ]),
      "canary_evidence_invalid",
    );
    expectCanaryFailure(
      "canary-pointer-evidence",
      canaryRecord([
        { kind: "live", uri: "https://github.com/CoreSaint/agent-kb" },
        { kind: "pointer", uri: "https://github.com/CoreSaint/agent-kb" },
      ]),
      "canary_evidence_invalid",
    );
    expectCanaryFailure(
      "canary-wrong-status",
      canaryRecord([{ kind: "live", uri: "https://github.com/CoreSaint/agent-kb" }], "draft"),
      "canary_record_invalid",
    );

    const validFixture = fixture();
    let mutationCalls = 0;
    const guardedStore = {
      get(id) { return store.get(id); },
      assemble(input) { return store.assemble(input); },
      mutate() { mutationCalls++; throw new Error("mutation path must remain unreachable"); },
    };
    const wrapped = gitPreflightAssemble(guardedStore, {
      branch, expected_head: localHead, query: recordId, risk_level: "R2", canonical_snippets: canonical,
    }, { runner: validFixture.runner, now: () => later });
    assert.notEqual(wrapped.assembly, null);
    assert.equal(wrapped.assembly.gate.allowed, true);
    assert.equal(mutationCalls, 0);
    assert.equal(Object.isFrozen(wrapped.verifier.receipt), true);
    assert.equal(JSON.stringify(wrapped).includes("@github.com"), false);
    assert.equal(wrapped.assembly.items[0].verification_required.includes("live"), false);

    const missingCanonical = gitPreflightAssemble(store, {
      branch, expected_head: localHead, query: recordId, risk_level: "R2", canonical_snippets: [],
    }, { runner: fixture().runner, now: () => later });
    assert.notEqual(missingCanonical.assembly, null);
    assert.equal(missingCanonical.assembly.gate.allowed, false);
    assert(missingCanonical.assembly.gate.reasons.some((reason) => reason.code === "canonical_verification_missing"));

    const verified = verifyGitPrepush(request(), fixture().runner, DEFAULT_GIT_PREPUSH_POLICY, checkedAt);
    assert.equal(verified.ok, true);
    const stale = validateGitPrepushReceipt(
      { ...verified.receipt, checked_at: "2026-07-25T11:58:59.999Z" }, request(), checkedAt,
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "stale_receipt");
    const future = validateGitPrepushReceipt(
      { ...verified.receipt, checked_at: "2026-07-25T12:00:00.001Z" }, request(), checkedAt,
    );
    assert.equal(future.ok, false);
    assert.equal(future.code, "future_receipt");
    const malformed = validateGitPrepushReceipt({ verifier: "git-prepush-v1" }, request(), checkedAt);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, "malformed_receipt");
    const changedState = validateGitPrepushReceipt({ ...verified.receipt, branch: "main" }, request(), checkedAt);
    assert.equal(changedState.ok, false);
    assert.equal(changedState.code, "receipt_state_mismatch");

    expectFailure({ dirty: true }, "dirty_worktree");
    expectFailure({ root: "/tmp/not-approved" }, "repository_mismatch");
    expectFailure({ branch: "main" }, "branch_mismatch");
    expectFailure({}, "head_mismatch", request("c".repeat(40)));
    const credentialFailure = expectFailure(
      { remoteUrl: "https://user:secret@github.com/CoreSaint/agent-kb.git" }, "remote_url_mismatch",
    );
    assert.equal(JSON.stringify(credentialFailure.result).includes("secret"), false);
    assert.equal(JSON.stringify(credentialFailure.result).includes("user"), false);
    expectFailure({ remoteRef: "refs/heads/main" }, "remote_ref_mismatch");
    expectFailure({ nonAncestor: true }, "remote_not_ancestor");
    expectFailure({ missingObject: true }, "missing_local_object");
    expectFailure({ commandFailure: "head" }, "command_failed");
    expectFailure({ malformedRemote: true }, "malformed_output");
    expectFailure({ secondRoot: "/tmp/not-approved" }, "repository_mismatch");
    expectFailure({ secondBranch: "main" }, "branch_mismatch");
    expectFailure({ secondHead: "c".repeat(40) }, "head_mismatch");
    expectFailure({ secondDirty: true }, "dirty_worktree");
    expectFailure({ secondRemoteUrl: "https://github.com/CoreSaint/agent-kb" }, "receipt_state_mismatch");
    expectFailure({ secondRemoteUrl: "https://example.invalid/unrelated" }, "remote_url_mismatch");
    expectFailure({ commandFailure: "head", commandFailurePass: 2 }, "command_failed");
    expectFailure({ secondRemoteHead: "c".repeat(40) }, "receipt_state_mismatch");
    expectFailure({ secondRemoteRef: "refs/heads/main" }, "remote_ref_mismatch");
    expectFailure({ commandFailure: "remote_ref", commandFailurePass: 2 }, "command_failed");

    const environment = buildGitRunnerEnvironment({
      PATH: "/safe/bin",
      HOME: "/secret/home",
      XDG_CONFIG_HOME: "/secret/xdg",
      HTTPS_PROXY: "https://user:secret@proxy.invalid",
      GIT_CONFIG_GLOBAL: "/secret/gitconfig",
      GIT_ASKPASS: "/secret/askpass",
      TOKEN: "secret-token",
    });
    assert.equal(environment.PATH, "/safe/bin");
    assert.equal(environment.HOME, "/dev/null");
    assert.equal(environment.XDG_CONFIG_HOME, "/dev/null");
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
    assert.equal(environment.GIT_ASKPASS, "/bin/false");
    assert.equal("HTTPS_PROXY" in environment, false);
    assert.equal("TOKEN" in environment, false);
    assert.equal(JSON.stringify(environment).includes("secret"), false);

    const unsafeRemoteCommand = { kind: "remote_url", repo, remote: "origin" };
    const sanitizedRemote = sanitizeGitCommandResult(unsafeRemoteCommand, {
      status: 0,
      stdout: "https://user:secret@github.com/CoreSaint/agent-kb.git\n",
    });
    assert.equal(sanitizedRemote.status, 2);
    assert.equal(sanitizedRemote.stdout, "");
    assert.equal(JSON.stringify(sanitizedRemote).includes("secret"), false);

    const commandArgs = validFixture.commands.map((command) => gitReadCommandArgs(command));
    assert.deepEqual(validFixture.commands.map((command) => command.kind), [
      "repository_root", "branch", "head", "status", "remote_url", "remote_ref", "local_object", "ancestry",
      "repository_root", "branch", "head", "status", "remote_url", "remote_ref",
    ]);
    const forbidden = new Set(["fetch", "push", "checkout", "switch", "reset", "clean", "add", "commit", "merge", "rebase", "tag"]);
    assert.equal(commandArgs.flat().some((argument) => forbidden.has(argument)), false);
    const lsRemote = commandArgs.find((args) => args.includes("ls-remote"));
    assert.deepEqual(lsRemote.slice(-4), ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);

    const loaded = await loadExtensions([extensionPath], root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const tools = loaded.extensions[0].tools;
    const expectedExisting = [
      "kb_archive", "kb_close", "kb_get", "kb_maintain", "kb_promote", "kb_purge_candidates",
      "kb_restore", "kb_search", "kb_status", "kb_supersede", "kb_upsert",
    ];
    assert.deepEqual([...tools.keys()].filter((name) => !name.includes("assemble")).sort(), expectedExisting);
    assert.equal([...tools.keys()].filter((name) => name === "kb_assemble").length, 1);
    assert.equal([...tools.keys()].filter((name) => name === "kb_git_preflight_assemble").length, 1);
    assert.equal(tools.size, expectedExisting.length + 2);

    const searchTool = tools.get("kb_search").definition;
    const searchGuidance = searchTool.promptGuidelines.join(" ");
    assert.match(searchGuidance, /Phase 5/);
    assert.match(searchGuidance, /Hindsight is frozen and legacy\/emergency only/);
    assert.doesNotMatch(searchGuidance, /Phase 3/);
    const upsertTool = tools.get("kb_upsert").definition;
    const promoteTool = tools.get("kb_promote").definition;
    const assembleTool = tools.get("kb_assemble").definition;
    const preflightTool = tools.get("kb_git_preflight_assemble").definition;
    const snapshot = {
      kind: "snapshot", uri: "file:///tmp/snapshot", observed_at: checkedAt.toISOString(), sha256: "d".repeat(64),
    };
    const live = { kind: "live", uri: "https://example.invalid/state", checked_at: checkedAt.toISOString() };
    const pointer = { kind: "pointer", uri: "memory:pointer" };
    for (const item of [snapshot, live, pointer]) {
      assert.equal(Value.Check(upsertTool.parameters, { id: "proposal:evidence", type: "proposal", title: "Evidence", evidence_items: [item] }), true);
    }
    assert.equal(Value.Check(upsertTool.parameters, {
      id: "proposal:bad-snapshot", type: "proposal", title: "Bad", evidence_items: [{ ...snapshot, sha256: "short" }],
    }), false);
    assert.equal(Value.Check(upsertTool.parameters, {
      id: "proposal:bad-live", type: "proposal", title: "Bad", evidence_items: [{ ...live, extra: true }],
    }), false);
    assert.equal(Value.Check(upsertTool.parameters, {
      id: "proposal:bad-pointer", type: "proposal", title: "Bad", evidence_items: [{ kind: "pointer", uri: "x", checked_at: checkedAt.toISOString() }],
    }), false);
    assert.equal(Value.Check(upsertTool.parameters, { id: "proposal:unknown", type: "proposal", title: "Bad", unknown: true }), false);
    assert.equal(Value.Check(assembleTool.parameters, { query: recordId, risk_level: "R2", unknown: true }), false);
    assert.equal(Value.Check(assembleTool.parameters, { query: recordId, risk_level: "R2", live_verified_record_ids: [recordId] }), false);
    assert.equal(Value.Check(assembleTool.parameters, { query: recordId, risk_level: "R2", receipt: verified.receipt }), false);
    const publicPreflight = {
      branch, expected_head: localHead, query: recordId, risk_level: "R2",
    };
    assert.equal(Value.Check(preflightTool.parameters, publicPreflight), true);
    assert.equal(Value.Check(preflightTool.parameters, { ...publicPreflight, record_id: "troubleshoot:unrelated" }), false);
    assert.equal(Value.Check(preflightTool.parameters, { ...publicPreflight, receipt: verified.receipt }), false);

    const directLive = await assembleTool.execute("direct-live", {
      query: recordId, risk_level: "R2", live_verified_record_ids: [recordId],
    });
    assert.equal(directLive.isError, true);
    const directReceipt = await assembleTool.execute("direct-receipt", {
      query: recordId, risk_level: "R2", receipt: verified.receipt,
    });
    assert.equal(directReceipt.isError, true);
    const directRecordInjection = await preflightTool.execute("direct-record-injection", {
      ...publicPreflight, record_id: "troubleshoot:unrelated",
    });
    assert.equal(directRecordInjection.isError, true);
    assert.match(directRecordInjection.content[0].text, /Unknown Git preflight assemble field 'record_id'/);
    const genericFirstPass = await assembleTool.execute("first-pass", {
      query: recordId, risk_level: "R2", canonical_snippets: canonical,
    });
    assert.equal(genericFirstPass.isError, undefined);
    assert.equal(genericFirstPass.details.gate.allowed, false);

    const dualUpsert = await upsertTool.execute("dual-upsert", {
      id: "proposal:dual-extension", type: "proposal", title: "Dual extension",
      evidence: ["memory:legacy"], evidence_items: [pointer],
    });
    assert.equal(dualUpsert.isError, true);
    assert.equal(store.get("proposal:dual-extension"), null);
    store.upsert({ id: "proposal:promote-dual", type: "proposal", title: "Promote dual" });
    const dualPromote = await promoteTool.execute("dual-promote", {
      proposalId: "proposal:promote-dual", id: "decision:promote-dual", type: "decision",
      evidence: ["memory:legacy"], evidence_items: [pointer],
    });
    assert.equal(dualPromote.isError, true);
    assert.equal(store.get("proposal:promote-dual").status, "open");
    assert.equal(store.get("decision:promote-dual"), null);
  } finally {
    store.dispose();
  }

  report = {
    ok: true,
    cases: 48,
    extension_tools: 13,
    verifier: "git-prepush-v1",
    isolated_root: root,
    live_database_touched: false,
    active_skills_touched: false,
    installed_extension_touched: false,
    network_used: false,
    mutation_called: false,
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "Slice 2 smoke cleanup failed");
console.log(JSON.stringify({ ...report, cleanup: true }, null, 2));
