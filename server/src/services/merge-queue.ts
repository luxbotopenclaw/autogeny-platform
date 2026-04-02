/**
 * Merge Queue Service
 *
 * Serializes merge requests per target branch so only one merge runs at a time.
 * Implements the CAID agent-optimal merge pipeline:
 *   rebase → static-analysis gate → git merge → archive
 *
 * 2-round cap with failure routing:
 *   - Round 1 failure → specific fix-request comment posted on linked issue
 *   - Round 2 failure → issue status set to `needs_spec_revision`, agent unassigned,
 *     escalation comment tagging the spec-writing agent (PM/CEO fallback)
 *
 * Security notes:
 *   - All git operations use execFile (never exec/shell:true) to prevent injection.
 *   - branchName and baseRef are validated against SAFE_REF_PATTERN before use.
 *   - workspacePath is path.resolve()-d and existence-checked before any git op.
 *   - Failure reasons in comments come from controlled sources (execFile stderr);
 *     they are wrapped in code fences and not treated as instructions.
 *   - Issue comments are posted as system-level (no authorAgentId/authorUserId),
 *     preventing agent identity spoofing.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues } from "@paperclipai/db";
import type { MergeQueueActiveItem, MergeQueueBranchStats, MergeQueueOutcome, MergeQueueStats } from "@paperclipai/shared";
import { runStaticAnalysisGate } from "./static-analysis-gate.js";

const execFileAsync = promisify(execFile);

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum milliseconds to wait for a single git operation. */
const GIT_TIMEOUT_MS = 60_000;

/** Maximum capture size for git output (to avoid memory bloat). */
const MAX_GIT_OUTPUT_BYTES = 32 * 1024;

/**
 * Only git ref names matching this pattern are passed to execFile.
 * Allows: alphanumerics, `.`, `-`, `_`, `/`, `@`, `{`, `}`.
 * Rejects: shell meta-characters, path traversal, etc.
 */
const SAFE_REF_PATTERN = /^[a-zA-Z0-9._\-/{}@]+$/;

// ─── In-memory state ─────────────────────────────────────────────────────────

/** Tail promise per branch key — ensures serialization. */
const queueTails = new Map<string, Promise<void>>();

/** Number of items waiting (not yet active) per branch key. */
const pendingCounts = new Map<string, number>();

/** Currently processing item per branch key. */
const activeItems = new Map<string, MergeQueueActiveItem>();

/** Per-issue round counter (resets on success). */
const roundsByIssueId = new Map<string, number>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function branchKey(companyId: string, baseRef: string): string {
  return `${companyId}:${baseRef}`;
}

function sanitizeRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  // Reject path traversal patterns (..) even though "." and "/" are allowed individually.
  if (trimmed.includes("..")) return null;
  return SAFE_REF_PATTERN.test(trimmed) ? trimmed : null;
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES * 2,
  });
  return {
    stdout: stdout.slice(0, MAX_GIT_OUTPUT_BYTES),
    stderr: stderr.slice(0, MAX_GIT_OUTPUT_BYTES),
  };
}

async function pathIsDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getMergeQueueStats(): MergeQueueStats {
  const allKeys = new Set([...pendingCounts.keys(), ...activeItems.keys()]);
  const branches: MergeQueueBranchStats[] = [];
  let totalQueued = 0;
  let totalActive = 0;

  for (const key of allKeys) {
    const queued = pendingCounts.get(key) ?? 0;
    const active = activeItems.get(key) ?? null;
    // Split key: first segment is companyId, rest is baseRef (may contain ":")
    const colonIdx = key.indexOf(":");
    const companyId = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
    const baseRef = colonIdx >= 0 ? key.slice(colonIdx + 1) : "";

    totalQueued += queued;
    if (active) totalActive += 1;

    branches.push({ key, companyId, baseRef, queuedCount: queued, activeItem: active });
  }

  return { totalQueued, totalActive, branches };
}

export interface EnqueueMergeParams {
  db: Db;
  companyId: string;
  workspaceId: string;
  issueId: string | null;
  branchName: string;
  baseRef: string;
  /** Absolute path to the execution workspace (git worktree or local fs checkout). */
  workspacePath: string;
  projectWorkspaceMetadata: Record<string, unknown> | null | undefined;
}

/**
 * Enqueue a merge attempt for a workspace branch.
 *
 * Returns only after the merge attempt (success OR failure) for this workspace
 * has completed. The caller can then proceed to archive the workspace on success,
 * or surface the failure to the user.
 *
 * Serialization guarantee: at most one merge per (companyId, baseRef) pair runs
 * concurrently — subsequent callers wait in a promise chain.
 */
export async function enqueueMerge(params: EnqueueMergeParams): Promise<MergeQueueOutcome> {
  const safeBranch = sanitizeRef(params.branchName);
  const safeBase = sanitizeRef(params.baseRef);

  if (!safeBranch || !safeBase) {
    return {
      status: "failed",
      reason: `Invalid branch name or base ref (contains disallowed characters): branch="${params.branchName}" base="${params.baseRef}"`,
      round: 0,
      escalated: false,
    };
  }

  const resolvedPath = path.resolve(params.workspacePath);
  if (!(await pathIsDirectory(resolvedPath))) {
    return {
      status: "failed",
      reason: `Workspace path does not exist or is not a directory: ${params.workspacePath}`,
      round: 0,
      escalated: false,
    };
  }

  const key = branchKey(params.companyId, safeBase);

  // Register as pending before chaining so stats are accurate immediately.
  pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1);

  const previous = queueTails.get(key) ?? Promise.resolve();

  let outcome: MergeQueueOutcome = { status: "skipped" };

  const myRun: Promise<void> = previous
    .catch(() => {
      // A previous merge failure must not block subsequent attempts.
    })
    .then(async () => {
      // Transition: pending → active
      pendingCounts.set(key, Math.max(0, (pendingCounts.get(key) ?? 1) - 1));
      if ((pendingCounts.get(key) ?? 0) === 0) pendingCounts.delete(key);

      activeItems.set(key, {
        workspaceId: params.workspaceId,
        issueId: params.issueId,
        branchName: safeBranch,
        enqueuedAt: new Date().toISOString(),
      });

      try {
        outcome = await doMerge({ ...params, branchName: safeBranch, baseRef: safeBase, workspacePath: resolvedPath });
      } finally {
        activeItems.delete(key);
        // Clean up empty queue entries so the map does not grow unbounded.
        if (!pendingCounts.has(key) && !activeItems.has(key)) {
          queueTails.delete(key);
        }
      }
    });

  // Update the tail so the next enqueue waits for us.
  queueTails.set(key, myRun);

  await myRun;
  return outcome;
}

// ─── Merge pipeline ──────────────────────────────────────────────────────────

async function doMerge(
  params: EnqueueMergeParams & { branchName: string; baseRef: string; workspacePath: string },
): Promise<MergeQueueOutcome> {
  const { db, companyId, workspaceId, issueId, branchName, baseRef, workspacePath, projectWorkspaceMetadata } = params;

  // ── Step 1: Fetch + rebase ──────────────────────────────────────────────────
  // Try to fetch the latest base ref so we detect conflicts against the current
  // remote state, not a stale local copy. Fetch failure is non-fatal.
  try {
    await runGit(["fetch", "--quiet", "origin"], workspacePath);
  } catch {
    // non-fatal
  }

  // Determine what to rebase onto: prefer origin/<baseRef> if it exists,
  // fall back to local <baseRef>.
  const remoteBase = `origin/${baseRef}`;
  let rebaseTarget = remoteBase;
  try {
    await runGit(["rev-parse", "--verify", remoteBase], workspacePath);
  } catch {
    rebaseTarget = baseRef;
  }

  try {
    await runGit(["rebase", rebaseTarget], workspacePath);
  } catch (rebaseErr) {
    // Abort to leave the workspace in a clean state for the agent to fix.
    try {
      await runGit(["rebase", "--abort"], workspacePath);
    } catch {
      // ignore abort errors
    }
    const errMsg =
      rebaseErr instanceof Error
        ? rebaseErr.message
        : String(rebaseErr);
    const reason = `Rebase conflict against \`${rebaseTarget}\`:\n${truncateOutput(errMsg)}`;
    return handleMergeFailure({ db, companyId, workspaceId, issueId, branchName, baseRef, reason });
  }

  // ── Step 2: Static analysis gate ───────────────────────────────────────────
  const gateResult = await runStaticAnalysisGate({
    workspacePath,
    projectWorkspaceMetadata,
  });

  if (!gateResult.passed && !gateResult.skipped) {
    const reason = gateResult.failureSummary ?? "Static analysis gate failed";
    return handleMergeFailure({ db, companyId, workspaceId, issueId, branchName, baseRef, reason });
  }

  // ── Step 3: Git merge into base branch ─────────────────────────────────────
  // Find the main repository root via the common git dir (works for worktrees).
  const mainRepoPath = await resolveMainRepoPath(workspacePath);

  if (mainRepoPath) {
    try {
      // Switch to the base branch in the main repo (not the worktree).
      await runGit(["checkout", baseRef], mainRepoPath);
      // Merge with --no-ff so the branch history is preserved.
      await runGit(["merge", "--no-ff", "--no-edit", branchName], mainRepoPath);
      // Restore the previous HEAD to avoid leaving the main repo in an unexpected state.
      try {
        await runGit(["checkout", "-"], mainRepoPath);
      } catch {
        // non-fatal: the merge succeeded; HEAD restoration is best-effort
      }
    } catch (mergeErr) {
      try {
        await runGit(["merge", "--abort"], mainRepoPath);
      } catch {
        // ignore
      }
      try {
        await runGit(["checkout", "-"], mainRepoPath);
      } catch {
        // ignore
      }
      const errMsg =
        mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      const reason = `Git merge of \`${branchName}\` into \`${baseRef}\` failed:\n${truncateOutput(errMsg)}`;
      return handleMergeFailure({ db, companyId, workspaceId, issueId, branchName, baseRef, reason });
    }
  }
  // If mainRepoPath is null (no git context), the rebase + gate already verified
  // the code quality; the archive proceeds without an explicit merge commit.

  // ── Success ────────────────────────────────────────────────────────────────
  if (issueId) {
    roundsByIssueId.delete(issueId);
  }
  return { status: "succeeded" };
}

async function resolveMainRepoPath(workspacePath: string): Promise<string | null> {
  try {
    // --git-common-dir returns the path to the main .git directory for worktrees.
    const { stdout } = await runGit(["rev-parse", "--git-common-dir"], workspacePath);
    const gitCommonDir = stdout.trim();
    if (!gitCommonDir) return null;

    // Resolve relative paths (git may return a relative path from cwd).
    const resolvedGitDir = path.resolve(workspacePath, gitCommonDir);

    // The main repo root is the parent of the .git directory.
    const repoRoot = path.dirname(resolvedGitDir);

    if (!(await pathIsDirectory(repoRoot))) return null;

    // If the worktree IS the main repo, use it directly.
    const resolvedWorkspace = path.resolve(workspacePath);
    if (repoRoot === resolvedWorkspace) {
      return repoRoot;
    }

    return repoRoot;
  } catch {
    return null;
  }
}

function truncateOutput(s: string): string {
  const maxBytes = 2048;
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  return Buffer.from(s, "utf8").slice(0, maxBytes).toString("utf8") + "\n… (truncated)";
}

// ─── Failure routing ─────────────────────────────────────────────────────────

interface FailureParams {
  db: Db;
  companyId: string;
  workspaceId: string;
  issueId: string | null;
  branchName: string;
  baseRef: string;
  reason: string;
}

async function handleMergeFailure(params: FailureParams): Promise<MergeQueueOutcome> {
  const { db, companyId, issueId, branchName, baseRef, reason } = params;

  if (!issueId) {
    return { status: "failed", reason, round: 1, escalated: false };
  }

  const issueRow = await db
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!issueRow) {
    return { status: "failed", reason, round: 1, escalated: false };
  }

  // Increment round count.
  const currentRound = roundsByIssueId.get(issueId) ?? 0;
  const newRound = currentRound + 1;
  roundsByIssueId.set(issueId, newRound);

  if (newRound < 2) {
    // ── Round 1: fix request ──────────────────────────────────────────────
    const comment = buildRound1Comment(branchName, baseRef, reason);
    await postSystemComment(db, companyId, issueId, comment);
    return { status: "failed", reason, round: newRound, escalated: false };
  }

  // ── Round 2+: escalation ─────────────────────────────────────────────────
  const escalationAgent = await findEscalationAgent(db, companyId);
  const comment = buildRound2Comment(branchName, baseRef, reason, escalationAgent);
  await postSystemComment(db, companyId, issueId, comment);

  // Update issue: unassign agent + set needs_spec_revision status.
  // Use compound WHERE (id + companyId) for defense-in-depth multi-tenancy.
  await db
    .update(issues)
    .set({
      status: "needs_spec_revision",
      assigneeAgentId: null,
      updatedAt: new Date(),
    })
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));

  return { status: "failed", reason, round: newRound, escalated: true };
}

async function findEscalationAgent(
  db: Db,
  companyId: string,
): Promise<{ id: string; name: string } | null> {
  for (const role of ["pm", "ceo"] as const) {
    const row = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, role)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (row) return { id: row.id, name: row.name };
  }
  return null;
}

async function postSystemComment(
  db: Db,
  companyId: string,
  issueId: string,
  body: string,
): Promise<void> {
  await db.insert(issueComments).values({
    id: randomUUID(),
    companyId,
    issueId,
    body,
    authorAgentId: null,
    authorUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// ─── Comment builders ────────────────────────────────────────────────────────

function buildRound1Comment(branchName: string, baseRef: string, reason: string): string {
  return [
    "## ⚠️ Merge Attempt Failed — Round 1 of 2",
    "",
    `Branch \`${branchName}\` could not be merged into \`${baseRef}\`.`,
    "",
    "**Failure reason:**",
    "```",
    reason.trim(),
    "```",
    "",
    "**Required action:** Fix the issues listed above and re-submit the workspace for merge.",
    "",
    "> ⚠️ A second failure will escalate this issue for spec revision and unassign the current agent.",
  ].join("\n");
}

function buildRound2Comment(
  branchName: string,
  baseRef: string,
  reason: string,
  escalationAgent: { id: string; name: string } | null,
): string {
  const mention = escalationAgent ? `@${escalationAgent.name}` : "@CEO";
  return [
    "## 🚨 Merge Failed — Escalating to Spec Revision (Round 2 of 2)",
    "",
    `Branch \`${branchName}\` failed to merge into \`${baseRef}\` for the **second time**.`,
    "The implementation agent has been unassigned. This issue now requires spec revision.",
    "",
    "**Failure reason:**",
    "```",
    reason.trim(),
    "```",
    "",
    `${mention} — please review the failure above and revise the issue spec before re-assigning.`,
    "",
    "**Suggested next steps:**",
    "1. Review the failure reason and identify any ambiguity in the original spec",
    "2. Revise the issue description with clearer acceptance criteria or constraints",
    "3. Re-assign to an implementation agent when the spec is ready",
  ].join("\n");
}

// ─── Exported utilities ──────────────────────────────────────────────────────

/**
 * Reset the round counter for an issue.
 * Call this if an issue is manually re-opened or the spec is revised.
 */
export function resetMergeRounds(issueId: string): void {
  roundsByIssueId.delete(issueId);
}

/**
 * Return the current merge round count for an issue (0 = no failures yet).
 * Primarily for testing.
 */
export function getMergeRoundCount(issueId: string): number {
  return roundsByIssueId.get(issueId) ?? 0;
}
