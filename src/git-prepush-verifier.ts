import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  validateAssembleInput,
  type AssembleLimits,
  type AssembleResult,
  type CanonicalSnippet,
  type RiskClass,
} from "./assembler.ts";
import type { KbStore } from "./store.ts";

export const GIT_PREPUSH_VERIFIER = "git-prepush-v1" as const;
export const GIT_PREPUSH_CANARY_RECORD_ID = "troubleshoot:git-prepush-canary" as const;
export const DEFAULT_GIT_PREPUSH_POLICY = Object.freeze({
  repo_realpath: "/var/home/marcin/Repo/agent-kb",
  remote_name: "origin",
  remote_url: "https://github.com/CoreSaint/agent-kb",
  max_receipt_age_ms: 60_000,
});

export interface GitPrepushPolicy {
  readonly repo_realpath: string;
  readonly remote_name: string;
  readonly remote_url: string;
  readonly max_receipt_age_ms: number;
}

export type GitReadCommand =
  | { readonly kind: "repository_root"; readonly repo: string }
  | { readonly kind: "branch"; readonly repo: string }
  | { readonly kind: "head"; readonly repo: string }
  | { readonly kind: "status"; readonly repo: string }
  | { readonly kind: "remote_url"; readonly repo: string; readonly remote: string }
  | { readonly kind: "remote_ref"; readonly repo: string; readonly remote: string; readonly ref: string }
  | { readonly kind: "local_object"; readonly repo: string; readonly object: string }
  | { readonly kind: "ancestry"; readonly repo: string; readonly ancestor: string; readonly descendant: string };

export interface GitCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly failure?: "timeout" | "output_limit" | "spawn";
}

export type GitCommandRunner = (command: GitReadCommand) => GitCommandResult;

const GIT_ENV_DEFAULTS = Object.freeze({
  HOME: "/dev/null",
  XDG_CONFIG_HOME: "/dev/null",
  XDG_CACHE_HOME: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  LC_ALL: "C",
});
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;
const SHA1 = /^[0-9a-f]{40}$/u;
const BRANCH = /^(?![./])(?!.*(?:\.\.|@\{|\/\/|\\|\s|[~^:?*\[]))(?!.*(?:\.|\/|\.lock)$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export function buildGitRunnerEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { ...GIT_ENV_DEFAULTS };
  if (typeof source.PATH === "string" && source.PATH.length > 0) environment.PATH = source.PATH;
  return Object.freeze(environment);
}

export function gitReadCommandArgs(command: GitReadCommand): readonly string[] {
  const prefix = ["-c", "credential.helper=", "-c", "core.askPass=", "-C", command.repo];
  switch (command.kind) {
    case "repository_root": return [...prefix, "rev-parse", "--show-toplevel"];
    case "branch": return [...prefix, "symbolic-ref", "--short", "HEAD"];
    case "head": return [...prefix, "rev-parse", "HEAD"];
    case "status": return [...prefix, "status", "--porcelain=v1"];
    case "remote_url": return [...prefix, "remote", "get-url", "--all", command.remote];
    case "remote_ref": return [...prefix, "ls-remote", "--exit-code", command.remote, command.ref];
    case "local_object": return [...prefix, "cat-file", "-e", `${command.object}^{commit}`];
    case "ancestry": return [...prefix, "merge-base", "--is-ancestor", command.ancestor, command.descendant];
  }
}

export function sanitizeGitCommandResult(command: GitReadCommand, result: GitCommandResult): GitCommandResult {
  if (command.kind !== "remote_url" || result.failure !== undefined || result.status !== 0) return result;
  const urls = result.stdout.trimEnd().split("\n");
  if (urls.length !== 1 || normalizeApprovedRemoteUrl(urls[0]) === null) {
    return Object.freeze({ status: 2, stdout: "" });
  }
  return result;
}

export const defaultGitCommandRunner: GitCommandRunner = (command) => {
  const result = spawnSync("git", gitReadCommandArgs(command), {
    cwd: command.repo,
    encoding: "utf8",
    env: buildGitRunnerEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    const code = Reflect.get(result.error, "code");
    const runnerFailure = code === "ETIMEDOUT" ? "timeout" : code === "ENOBUFS" ? "output_limit" : "spawn";
    return Object.freeze({ status: null, stdout: "", failure: runnerFailure });
  }
  return sanitizeGitCommandResult(command, Object.freeze({ status: result.status, stdout: result.stdout }));
};

export interface GitPrepushRequest {
  readonly record_id: string;
  readonly branch: string;
  readonly expected_head: string;
}

export interface GitPrepushReceipt {
  readonly record_id: string;
  readonly verifier: typeof GIT_PREPUSH_VERIFIER;
  readonly checked_at: string;
  readonly repo_realpath: string;
  readonly branch: string;
  readonly local_head: string;
  readonly remote_name: string;
  readonly remote_ref: string;
  readonly remote_head: string;
  readonly worktree_clean: true;
  readonly remote_is_ancestor: true;
  readonly expected_head_matches: true;
}

export type GitPrepushFailureCode =
  | "invalid_request"
  | "repository_mismatch"
  | "branch_mismatch"
  | "head_mismatch"
  | "dirty_worktree"
  | "remote_url_mismatch"
  | "remote_ref_mismatch"
  | "missing_local_object"
  | "remote_not_ancestor"
  | "command_failed"
  | "malformed_output"
  | "malformed_receipt"
  | "stale_receipt"
  | "future_receipt"
  | "receipt_state_mismatch"
  | "canary_record_missing"
  | "canary_record_invalid"
  | "canary_evidence_invalid";

export interface GitPrepushFailure {
  readonly ok: false;
  readonly code: GitPrepushFailureCode;
  readonly operation?: GitReadCommand["kind"];
}

export interface GitPrepushSuccess {
  readonly ok: true;
  readonly receipt: GitPrepushReceipt;
}

export type GitPrepushOutcome = GitPrepushSuccess | GitPrepushFailure;

function failure(code: GitPrepushFailureCode, operation?: GitReadCommand["kind"]): GitPrepushFailure {
  return operation === undefined ? Object.freeze({ ok: false, code }) : Object.freeze({ ok: false, code, operation });
}

function oneLine(result: GitCommandResult, operation: GitReadCommand["kind"]): string | GitPrepushFailure {
  if (result.failure !== undefined || result.status !== 0) return failure("command_failed", operation);
  const lines = result.stdout.trimEnd().split("\n");
  if (lines.length !== 1 || !lines[0].trim()) return failure("malformed_output", operation);
  return lines[0].trim();
}

function runOneLine(runner: GitCommandRunner, command: GitReadCommand): string | GitPrepushFailure {
  return oneLine(runner(command), command.kind);
}

function isFailure(value: string | GitPrepushFailure): value is GitPrepushFailure {
  return typeof value !== "string";
}

function validRequest(request: GitPrepushRequest): boolean {
  return request.record_id.length > 0
    && request.record_id.length <= 256
    && request.record_id.trim() === request.record_id
    && !request.record_id.includes("\0")
    && BRANCH.test(request.branch)
    && SHA1.test(request.expected_head);
}

export function normalizeApprovedRemoteUrl(value: string, approved = DEFAULT_GIT_PREPUSH_POLICY.remote_url): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) return null;
  if (url.pathname !== "/CoreSaint/agent-kb" && url.pathname !== "/CoreSaint/agent-kb.git") return null;
  const normalized = `${url.protocol}//${url.host}${url.pathname.endsWith(".git") ? url.pathname.slice(0, -4) : url.pathname}`;
  return normalized === approved ? normalized : null;
}

function resolvedAllowedRepo(policy: GitPrepushPolicy): string | GitPrepushFailure {
  try {
    const resolved = realpathSync(policy.repo_realpath);
    return resolved === policy.repo_realpath ? resolved : failure("repository_mismatch");
  } catch {
    return failure("repository_mismatch");
  }
}

function parseRemoteRef(value: string, expectedRef: string): string | GitPrepushFailure {
  const match = /^([0-9a-f]{40})\t([^\s]+)$/u.exec(value);
  if (match === null) return failure("malformed_output", "remote_ref");
  if (match[2] !== expectedRef) return failure("remote_ref_mismatch", "remote_ref");
  return match[1];
}

interface GitRepositoryState {
  readonly root: string;
  readonly branch: string;
  readonly head: string;
  readonly remote_url: string;
}

function readGitRepositoryState(
  runner: GitCommandRunner,
  repo: string,
  request: GitPrepushRequest,
  policy: GitPrepushPolicy,
): GitRepositoryState | GitPrepushFailure {
  const root = runOneLine(runner, { kind: "repository_root", repo });
  if (isFailure(root)) return root;
  if (root !== repo) return failure("repository_mismatch", "repository_root");

  const branch = runOneLine(runner, { kind: "branch", repo });
  if (isFailure(branch)) return branch;
  if (branch !== request.branch) return failure("branch_mismatch", "branch");

  const head = runOneLine(runner, { kind: "head", repo });
  if (isFailure(head)) return head;
  if (!SHA1.test(head)) return failure("malformed_output", "head");
  if (head !== request.expected_head) return failure("head_mismatch", "head");

  const status = runner({ kind: "status", repo });
  if (status.failure !== undefined || status.status !== 0) return failure("command_failed", "status");
  if (status.stdout !== "") return failure("dirty_worktree", "status");

  const remoteUrl = runOneLine(runner, { kind: "remote_url", repo, remote: policy.remote_name });
  if (isFailure(remoteUrl)) return remoteUrl;
  if (normalizeApprovedRemoteUrl(remoteUrl, policy.remote_url) === null) {
    return failure("remote_url_mismatch", "remote_url");
  }
  return Object.freeze({ root, branch, head, remote_url: remoteUrl });
}

function isRepositoryStateFailure(
  value: GitRepositoryState | GitPrepushFailure,
): value is GitPrepushFailure {
  return "code" in value;
}

export function verifyGitPrepush(
  request: GitPrepushRequest,
  runner: GitCommandRunner = defaultGitCommandRunner,
  policy: GitPrepushPolicy = DEFAULT_GIT_PREPUSH_POLICY,
  checkedAt: Date = new Date(),
): GitPrepushOutcome {
  if (!validRequest(request) || !Number.isFinite(checkedAt.valueOf())) return failure("invalid_request");
  const repo = resolvedAllowedRepo(policy);
  if (typeof repo !== "string") return repo;

  const initialState = readGitRepositoryState(runner, repo, request, policy);
  if (isRepositoryStateFailure(initialState)) return initialState;

  const remoteRef = `refs/heads/${request.branch}`;
  const remoteLine = runOneLine(runner, { kind: "remote_ref", repo, remote: policy.remote_name, ref: remoteRef });
  if (isFailure(remoteLine)) return remoteLine;
  const remoteHead = parseRemoteRef(remoteLine, remoteRef);
  if (typeof remoteHead !== "string") return remoteHead;

  const objectResult = runner({ kind: "local_object", repo, object: remoteHead });
  if (objectResult.failure !== undefined) return failure("command_failed", "local_object");
  if (objectResult.status !== 0) return failure("missing_local_object", "local_object");

  const ancestryResult = runner({ kind: "ancestry", repo, ancestor: remoteHead, descendant: initialState.head });
  if (ancestryResult.failure !== undefined || ancestryResult.status === null || ancestryResult.status > 1) {
    return failure("command_failed", "ancestry");
  }
  if (ancestryResult.status !== 0) return failure("remote_not_ancestor", "ancestry");

  const finalState = readGitRepositoryState(runner, repo, request, policy);
  if (isRepositoryStateFailure(finalState)) return finalState;
  if (
    finalState.root !== initialState.root
    || finalState.branch !== initialState.branch
    || finalState.head !== initialState.head
    || finalState.remote_url !== initialState.remote_url
  ) return failure("receipt_state_mismatch");

  const finalRemoteLine = runOneLine(runner, {
    kind: "remote_ref", repo, remote: policy.remote_name, ref: remoteRef,
  });
  if (isFailure(finalRemoteLine)) return finalRemoteLine;
  const finalRemoteHead = parseRemoteRef(finalRemoteLine, remoteRef);
  if (typeof finalRemoteHead !== "string") return finalRemoteHead;
  if (finalRemoteHead !== remoteHead) return failure("receipt_state_mismatch", "remote_ref");

  const receipt: GitPrepushReceipt = Object.freeze({
    record_id: request.record_id,
    verifier: GIT_PREPUSH_VERIFIER,
    checked_at: checkedAt.toISOString(),
    repo_realpath: repo,
    branch: finalState.branch,
    local_head: finalState.head,
    remote_name: policy.remote_name,
    remote_ref: remoteRef,
    remote_head: remoteHead,
    worktree_clean: true,
    remote_is_ancestor: true,
    expected_head_matches: true,
  });
  return Object.freeze({ ok: true, receipt });
}

function receiptString(value: unknown, name: keyof GitPrepushReceipt): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const field = Reflect.get(value, name);
  return typeof field === "string" ? field : null;
}

export function validateGitPrepushReceipt(
  value: unknown,
  request: GitPrepushRequest,
  now: Date = new Date(),
  policy: GitPrepushPolicy = DEFAULT_GIT_PREPUSH_POLICY,
): GitPrepushOutcome {
  if (!validRequest(request) || !Number.isFinite(now.valueOf()) || typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("malformed_receipt");
  }
  const allowed = [
    "record_id", "verifier", "checked_at", "repo_realpath", "branch", "local_head", "remote_name",
    "remote_ref", "remote_head", "worktree_clean", "remote_is_ancestor", "expected_head_matches",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return failure("malformed_receipt");

  const checkedAt = receiptString(value, "checked_at");
  const remoteHead = receiptString(value, "remote_head");
  if (checkedAt === null || remoteHead === null || !ISO_TIMESTAMP.test(checkedAt) || !SHA1.test(remoteHead)) {
    return failure("malformed_receipt");
  }
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedMs)) return failure("malformed_receipt");
  if (checkedMs > now.valueOf()) return failure("future_receipt");
  if (now.valueOf() - checkedMs > policy.max_receipt_age_ms) return failure("stale_receipt");

  const exact = receiptString(value, "record_id") === request.record_id
    && receiptString(value, "verifier") === GIT_PREPUSH_VERIFIER
    && receiptString(value, "repo_realpath") === policy.repo_realpath
    && receiptString(value, "branch") === request.branch
    && receiptString(value, "local_head") === request.expected_head
    && receiptString(value, "remote_name") === policy.remote_name
    && receiptString(value, "remote_ref") === `refs/heads/${request.branch}`
    && Reflect.get(value, "worktree_clean") === true
    && Reflect.get(value, "remote_is_ancestor") === true
    && Reflect.get(value, "expected_head_matches") === true;
  if (!exact) return failure("receipt_state_mismatch");

  const receipt: GitPrepushReceipt = Object.freeze({
    record_id: request.record_id,
    verifier: GIT_PREPUSH_VERIFIER,
    checked_at: checkedAt,
    repo_realpath: policy.repo_realpath,
    branch: request.branch,
    local_head: request.expected_head,
    remote_name: policy.remote_name,
    remote_ref: `refs/heads/${request.branch}`,
    remote_head: remoteHead,
    worktree_clean: true,
    remote_is_ancestor: true,
    expected_head_matches: true,
  });
  return Object.freeze({ ok: true, receipt });
}

export interface GitPreflightAssembleInput {
  readonly branch: string;
  readonly expected_head: string;
  readonly query: string;
  readonly risk_level: RiskClass;
  readonly canonical_snippets?: readonly CanonicalSnippet[];
  readonly limits?: Partial<AssembleLimits>;
}

function validateCanaryRecord(
  store: Pick<KbStore, "get">,
  policy: GitPrepushPolicy,
): GitPrepushFailure | null {
  const record = store.get(GIT_PREPUSH_CANARY_RECORD_ID);
  if (record === null) return failure("canary_record_missing");
  if (record.type !== "troubleshoot" || (record.status !== "active" && record.status !== "done")) {
    return failure("canary_record_invalid");
  }
  let approvedLiveEvidence = 0;
  for (const evidence of record.evidence_items) {
    if (evidence.kind === "pointer") return failure("canary_evidence_invalid");
    if (evidence.kind === "live") {
      if (normalizeApprovedRemoteUrl(evidence.uri, policy.remote_url) === null) {
        return failure("canary_evidence_invalid");
      }
      approvedLiveEvidence++;
    }
  }
  return approvedLiveEvidence > 0 ? null : failure("canary_evidence_invalid");
}

export type GitPreflightAssembleResult =
  | { readonly verifier: GitPrepushFailure; readonly assembly: null }
  | { readonly verifier: GitPrepushSuccess; readonly assembly: AssembleResult };

export function gitPreflightAssemble(
  store: Pick<KbStore, "get" | "assemble">,
  input: GitPreflightAssembleInput,
  options: {
    readonly runner?: GitCommandRunner;
    readonly policy?: GitPrepushPolicy;
    readonly now?: () => Date;
  } = {},
): GitPreflightAssembleResult {
  const policy = options.policy ?? DEFAULT_GIT_PREPUSH_POLICY;
  const canaryFailure = validateCanaryRecord(store, policy);
  if (canaryFailure !== null) return Object.freeze({ verifier: canaryFailure, assembly: null });
  const request: GitPrepushRequest = {
    record_id: GIT_PREPUSH_CANARY_RECORD_ID,
    branch: input.branch,
    expected_head: input.expected_head,
  };
  const clock = options.now ?? (() => new Date());
  const checkedAt = clock();
  const verifier = verifyGitPrepush(request, options.runner ?? defaultGitCommandRunner, policy, checkedAt);
  if (!verifier.ok) return Object.freeze({ verifier, assembly: null });
  const validationNow = clock();
  const validated = validateGitPrepushReceipt(verifier.receipt, request, validationNow, policy);
  if (!validated.ok) return Object.freeze({ verifier: validated, assembly: null });
  const assembleInput = validateAssembleInput({
    query: input.query,
    risk_class: input.risk_level,
    now: validationNow.toISOString(),
    canonical_snippets: input.canonical_snippets ?? [],
    live_verified_record_ids: [GIT_PREPUSH_CANARY_RECORD_ID],
    limits: input.limits,
  });
  return Object.freeze({ verifier: validated, assembly: store.assemble(assembleInput) });
}
