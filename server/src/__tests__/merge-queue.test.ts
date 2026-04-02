/**
 * Tests for the merge queue service.
 *
 * Uses real filesystem temporary directories but stubs out execFile (git) and
 * the static analysis gate so actual git/tsc/eslint binaries are not required.
 *
 * Key scenarios:
 *   - Success path: resolves with "succeeded"
 *   - Rebase failure → round-1: comment posted, not escalated
 *   - Second rebase failure → round-2: issue escalated, status=needs_spec_revision
 *   - Queue serialization: concurrent enqueues on same branch wait in order
 *   - Stats: queued/active counts
 *   - Input validation: invalid refs rejected before any git call
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Module-level mocks (must be before imports of the mocked modules) ────────

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../services/static-analysis-gate.js", () => ({
  runStaticAnalysisGate: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import type { Mock } from "vitest";
import { runStaticAnalysisGate } from "../services/static-analysis-gate.js";

import {
  enqueueMerge,
  getMergeQueueStats,
  getMergeRoundCount,
  resetMergeRounds,
} from "../services/merge-queue.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const execFileMock = execFile as unknown as Mock;
const staticGateMock = runStaticAnalysisGate as unknown as Mock;

interface DbStub {
  _comments: Array<{ id: string; issueId: string; companyId: string; body: string }>;
  _issueUpdates: Array<{ status?: string; assigneeAgentId?: null }>;
}

function makeDb(opts?: {
  issueExists?: boolean;
  agentName?: string;
}): ReturnType<typeof makeDbImpl> & DbStub {
  return makeDbImpl(opts);
}

function makeDbImpl(opts?: { issueExists?: boolean; agentName?: string }) {
  const comments: Array<{ id: string; issueId: string; companyId: string; body: string }> = [];
  const issueUpdates: Array<{ status?: string; assigneeAgentId?: null }> = [];
  const issueExists = opts?.issueExists !== false;
  const agentName = opts?.agentName ?? "PM-Agent";

  return {
    _comments: comments,
    _issueUpdates: issueUpdates,
    select: () => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => ({
            then: (fn: (rows: unknown[]) => unknown) =>
              Promise.resolve(fn([{ id: "agent-1", name: agentName }])),
          }),
          then: (fn: (rows: unknown[]) => unknown) => {
            if (!issueExists) return Promise.resolve(fn([]));
            return Promise.resolve(fn([{ id: "issue-1", companyId: "company-1" }]));
          },
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (data: { id: string; issueId: string; companyId: string; body: string }) => {
        comments.push(data);
        return Promise.resolve();
      },
    }),
    update: (_table: unknown) => ({
      set: (patch: { status?: string; assigneeAgentId?: null }) => {
        issueUpdates.push(patch);
        return { where: (_cond: unknown) => Promise.resolve() };
      },
    }),
  };
}

/** Make git ops succeed silently. */
function mockGitSuccess() {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown,
     cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "", stderr: "" });
    },
  );
}

/** Make git rebase fail with a conflict. All other git ops succeed. */
function mockGitRebaseConflict() {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown,
     cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void) => {
      const isRebase = Array.isArray(args) && args.includes("rebase") && !args.includes("--abort");
      if (isRebase) {
        const err = Object.assign(new Error("CONFLICT: Merge conflict in src/foo.ts"), {
          stdout: "",
          stderr: "CONFLICT (content): Merge conflict in src/foo.ts\nerror: could not apply abc1234...",
          code: 1,
        });
        cb(err);
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    },
  );
}

function mockGatePass() {
  staticGateMock.mockResolvedValue({ passed: true, skipped: false, results: [], failureSummary: null });
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mq-test-"));
  vi.clearAllMocks();
  mockGitSuccess();
  mockGatePass();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Success path ─────────────────────────────────────────────────────────────

describe("enqueueMerge — success", () => {
  it("returns succeeded when rebase and gate pass", async () => {
    const db = makeDb();
    const result = await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId: "issue-1",
      branchName: "feature/my-branch",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });
    expect(result.status).toBe("succeeded");
  });

  it("does not post any comment on success", async () => {
    const db = makeDb();
    await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId: "issue-1",
      branchName: "feature/ok",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });
    expect(db._comments).toHaveLength(0);
  });

  it("clears round count after success", async () => {
    const issueId = "issue-clear-" + Math.random();
    resetMergeRounds(issueId);

    const db = makeDb();
    // Cause a round-1 failure first
    mockGitRebaseConflict();
    await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId,
      branchName: "feature/fix",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });
    expect(getMergeRoundCount(issueId)).toBe(1);

    // Now succeed
    mockGitSuccess();
    await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId,
      branchName: "feature/fix",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });
    expect(getMergeRoundCount(issueId)).toBe(0);
  });
});

// ─── Round-1 failure ──────────────────────────────────────────────────────────

describe("enqueueMerge — round-1 rebase failure", () => {
  it("returns failed with round=1, escalated=false", async () => {
    const issueId = "issue-r1-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb();
    mockGitRebaseConflict();

    const result = await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId,
      branchName: "feature/conflict",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.round).toBe(1);
      expect(result.escalated).toBe(false);
      expect(result.reason).toContain("Rebase conflict");
    }
  });

  it("posts a round-1 comment on the issue", async () => {
    const issueId = "issue-r1c-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb();
    mockGitRebaseConflict();

    await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId,
      branchName: "feature/conflict",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });

    expect(db._comments).toHaveLength(1);
    expect(db._comments[0]!.body).toContain("Round 1 of 2");
    expect(db._comments[0]!.body).toContain("feature/conflict");
    expect(db._comments[0]!.body).toContain("main");
  });

  it("does NOT update issue status or assignee on round-1", async () => {
    const issueId = "issue-r1-noupdate-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb();
    mockGitRebaseConflict();

    await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId,
      branchName: "feature/conflict",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });

    expect(db._issueUpdates).toHaveLength(0);
  });
});

// ─── Round-2 escalation ───────────────────────────────────────────────────────

describe("enqueueMerge — round-2 escalation", () => {
  async function causeRound2(db: ReturnType<typeof makeDb>, issueId: string) {
    const params = {
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId,
      branchName: "feature/escalate",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null as Record<string, unknown> | null,
    };

    mockGitRebaseConflict();
    await enqueueMerge(params);

    mockGitRebaseConflict();
    return enqueueMerge(params);
  }

  it("returns failed with round=2, escalated=true", async () => {
    const issueId = "issue-r2-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb();
    const result = await causeRound2(db, issueId);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.round).toBe(2);
      expect(result.escalated).toBe(true);
    }
  });

  it("sets issue status=needs_spec_revision and nulls assigneeAgentId", async () => {
    const issueId = "issue-r2-update-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb();
    await causeRound2(db, issueId);

    const update = db._issueUpdates.find((u) => u.status === "needs_spec_revision");
    expect(update).toBeDefined();
    expect(update?.assigneeAgentId).toBeNull();
  });

  it("posts an escalation comment tagging the PM agent", async () => {
    const issueId = "issue-r2-comment-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb({ agentName: "ProjectManager" });
    await causeRound2(db, issueId);

    const esc = db._comments.find((c) => c.body.includes("Escalating to Spec Revision"));
    expect(esc).toBeDefined();
    expect(esc!.body).toContain("@ProjectManager");
  });

  it("posts exactly 2 comments total (round-1 + escalation)", async () => {
    const issueId = "issue-r2-count-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb();
    await causeRound2(db, issueId);

    expect(db._comments).toHaveLength(2);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe("enqueueMerge — input validation", () => {
  it("rejects invalid branchName with shell meta-chars", async () => {
    const db = makeDb();
    const result = await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId: null,
      branchName: "feature/$(rm -rf /)",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });

    expect(result.status).toBe("failed");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects baseRef with path traversal", async () => {
    const db = makeDb();
    const result = await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId: null,
      branchName: "feature/ok",
      baseRef: "../../etc/passwd",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });

    expect(result.status).toBe("failed");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects non-existent workspacePath", async () => {
    const db = makeDb();
    const result = await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-1",
      issueId: null,
      branchName: "feature/ok",
      baseRef: "main",
      workspacePath: "/nonexistent/path/xyzzy123",
      projectWorkspaceMetadata: null,
    });

    expect(result.status).toBe("failed");
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ─── Queue serialization ──────────────────────────────────────────────────────

describe("Queue serialization", () => {
  it("processes two concurrent enqueues for the same branch sequentially", async () => {
    const order: string[] = [];
    const db = makeDb();

    // Use a small async delay for the first few calls to ensure overlap.
    let callCount = 0;
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown,
       cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        callCount += 1;
        const delay = callCount <= 3 ? 20 : 0;
        setTimeout(() => cb(null, { stdout: "", stderr: "" }), delay);
      },
    );

    const baseParams = {
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-serial",
      issueId: null as string | null,
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null as Record<string, unknown> | null,
    };

    const run1 = enqueueMerge({ ...baseParams, workspaceId: "ws-s1", branchName: "feature/serial-1" })
      .then((r) => { order.push("ws-s1"); return r; });

    const run2 = enqueueMerge({ ...baseParams, workspaceId: "ws-s2", branchName: "feature/serial-2" })
      .then((r) => { order.push("ws-s2"); return r; });

    await Promise.all([run1, run2]);

    expect(order).toEqual(["ws-s1", "ws-s2"]);
  });

  it("does NOT serialize enqueues for different base branches", async () => {
    const db = makeDb();

    const [r1, r2] = await Promise.all([
      enqueueMerge({
        db: db as unknown as import("@paperclipai/db").Db,
        companyId: "company-par",
        workspaceId: "ws-p1",
        issueId: null,
        branchName: "feature/par-1",
        baseRef: "main",
        workspacePath: tmpDir,
        projectWorkspaceMetadata: null,
      }),
      enqueueMerge({
        db: db as unknown as import("@paperclipai/db").Db,
        companyId: "company-par",
        workspaceId: "ws-p2",
        issueId: null,
        branchName: "feature/par-2",
        baseRef: "develop",
        workspacePath: tmpDir,
        projectWorkspaceMetadata: null,
      }),
    ]);

    expect(r1.status).toBe("succeeded");
    expect(r2.status).toBe("succeeded");
  });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

describe("getMergeQueueStats", () => {
  it("returns correct shape", () => {
    const stats = getMergeQueueStats();
    expect(typeof stats.totalQueued).toBe("number");
    expect(typeof stats.totalActive).toBe("number");
    expect(Array.isArray(stats.branches)).toBe(true);
  });
});

// ─── Round counter utilities ──────────────────────────────────────────────────

describe("getMergeRoundCount / resetMergeRounds", () => {
  it("returns 0 for a new issue id", () => {
    expect(getMergeRoundCount("brand-new-" + Math.random())).toBe(0);
  });

  it("increments after a failed merge", async () => {
    const issueId = "cnt-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb();
    mockGitRebaseConflict();

    await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-cnt",
      issueId,
      branchName: "feature/cnt",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });

    expect(getMergeRoundCount(issueId)).toBe(1);
  });

  it("resets to 0 after resetMergeRounds", async () => {
    const issueId = "rst-" + Math.random();
    resetMergeRounds(issueId);
    const db = makeDb();
    mockGitRebaseConflict();

    await enqueueMerge({
      db: db as unknown as import("@paperclipai/db").Db,
      companyId: "company-1",
      workspaceId: "ws-rst",
      issueId,
      branchName: "feature/rst",
      baseRef: "main",
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
    });

    expect(getMergeRoundCount(issueId)).toBe(1);
    resetMergeRounds(issueId);
    expect(getMergeRoundCount(issueId)).toBe(0);
  });
});
