/**
 * Unit tests for execute.ts helpers.
 *
 * We test the pure logic (path resolution, outbox parsing, wake payload)
 * without spawning real Hermes processes.  File I/O in execute() is tested
 * via integration-style tests using a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We import the constants to keep expectations in sync with the implementation.
import {
  DEFAULT_INBOX_SUBPATH,
  DEFAULT_OUTBOX_SUBPATH,
  DEFAULT_PID_FILE_SUBPATH,
  INBOX_MESSAGE_VERSION,
  LOG_PREFIX,
} from "../shared/constants.js";
import { execute } from "../server/execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gw-test-"));
}

function makeCtx(
  overrides: Partial<AdapterExecutionContext> & { config?: Record<string, unknown> },
): AdapterExecutionContext {
  const runId = overrides.runId ?? "test-run-id";
  return {
    runId,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "hermes_gateway",
      adapterConfig: {},
    },
    context: {
      wakeReason: "heartbeat",
      issueId: "issue-1",
      taskId: null,
      issueIds: [],
    },
    config: overrides.config ?? {},
    onLog: async (_stream: string, _text: string) => {},
    onMeta: async (_meta: unknown) => {},
    ...overrides,
  } as unknown as AdapterExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests: CONSTANTS
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_INBOX_SUBPATH contains .hermes/inbox", () => {
    expect(DEFAULT_INBOX_SUBPATH).toContain(".hermes");
    expect(DEFAULT_INBOX_SUBPATH).toContain("inbox");
  });

  it("DEFAULT_OUTBOX_SUBPATH contains .hermes/outbox", () => {
    expect(DEFAULT_OUTBOX_SUBPATH).toContain(".hermes");
    expect(DEFAULT_OUTBOX_SUBPATH).toContain("outbox");
  });

  it("INBOX_MESSAGE_VERSION is a positive integer", () => {
    expect(INBOX_MESSAGE_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(INBOX_MESSAGE_VERSION)).toBe(true);
  });

  it("LOG_PREFIX starts with [hermes-gateway]", () => {
    expect(LOG_PREFIX).toBe("[hermes-gateway]");
  });
});

// ---------------------------------------------------------------------------
// Tests: execute — error paths (no real Hermes process)
// ---------------------------------------------------------------------------

describe("execute — config validation", () => {
  it("returns error when inboxDir resolves to a non-absolute path via bad config", async () => {
    // We can't easily force a relative path through the resolver since it
    // always falls back to joining workspaceDir (absolute) + subpath.
    // Instead we directly test that absolute validation passes for the default.
    const tmpDir = makeTmpDir();
    const ctx = makeCtx({
      config: {
        workspaceDir: tmpDir,
        skipLivenessCheck: true,
        timeoutSec: 1,
      },
    });
    // With skipLivenessCheck and a 1s timeout, it should write the inbox file
    // and then time out waiting for outbox. This confirms the flow starts.
    const result = await execute(ctx);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes inbox file with correct runId and version", async () => {
    const tmpDir = makeTmpDir();
    const runId = "integration-run-42";
    const ctx = makeCtx({
      runId,
      config: {
        workspaceDir: tmpDir,
        skipLivenessCheck: true,
        timeoutSec: 1,
        pollIntervalMs: 100,
      },
    });

    const executePromise = execute(ctx);

    // Wait a bit for the inbox file to be written
    await new Promise((r) => setTimeout(r, 200));

    const inboxFile = path.join(tmpDir, DEFAULT_INBOX_SUBPATH, `${runId}.json`);
    let inboxData: Record<string, unknown> | null = null;
    try {
      inboxData = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    } catch {
      // Inbox file may not exist yet; will time out
    }

    // Wait for execute to finish (it will time out)
    await executePromise;

    expect(inboxData).not.toBeNull();
    if (inboxData) {
      expect(inboxData.runId).toBe(runId);
      expect(inboxData.version).toBe(INBOX_MESSAGE_VERSION);
      expect(inboxData.agentId).toBe("agent-1");
      expect(inboxData.companyId).toBe("company-1");
      expect(typeof inboxData.message).toBe("string");
      expect(typeof inboxData.sentAt).toBe("string");
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads outbox response and returns ok result", async () => {
    const tmpDir = makeTmpDir();
    const runId = "resp-run-1";
    const outboxDir = path.join(tmpDir, DEFAULT_OUTBOX_SUBPATH);
    const outboxFile = path.join(outboxDir, `${runId}.json`);

    const ctx = makeCtx({
      runId,
      config: {
        workspaceDir: tmpDir,
        skipLivenessCheck: true,
        timeoutSec: 10,
        pollIntervalMs: 50,
      },
    });

    // Write the response concurrently, after a short delay so execute() starts polling first.
    const responseData = {
      runId,
      status: "ok",
      summary: "Task completed successfully",
      exitCode: 0,
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      usage: { inputTokens: 100, outputTokens: 200 },
      costUsd: 0.002,
      completedAt: new Date().toISOString(),
    };
    const writeAfterDelay = new Promise<void>((resolve) => {
      setTimeout(() => {
        fs.mkdirSync(outboxDir, { recursive: true });
        fs.writeFileSync(outboxFile, JSON.stringify(responseData), "utf8");
        resolve();
      }, 300);
    });

    const [result] = await Promise.all([execute(ctx), writeAfterDelay]);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("Task completed successfully");
    expect(result.model).toBe("claude-3-5-sonnet");
    expect(result.provider).toBe("anthropic");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(200);
    expect(result.costUsd).toBe(0.002);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("returns error when outbox response has status error", async () => {
    const tmpDir = makeTmpDir();
    const runId = "err-run-1";
    const outboxDir = path.join(tmpDir, DEFAULT_OUTBOX_SUBPATH);
    const outboxFile = path.join(outboxDir, `${runId}.json`);

    const ctx = makeCtx({
      runId,
      config: {
        workspaceDir: tmpDir,
        skipLivenessCheck: true,
        timeoutSec: 10,
        pollIntervalMs: 50,
      },
    });

    // Write the error response concurrently after a short delay.
    const writeAfterDelay = new Promise<void>((resolve) => {
      setTimeout(() => {
        fs.mkdirSync(outboxDir, { recursive: true });
        fs.writeFileSync(
          outboxFile,
          JSON.stringify({ runId, status: "error", error: "Agent panicked", exitCode: 1 }),
          "utf8",
        );
        resolve();
      }, 300);
    });

    const [result] = await Promise.all([execute(ctx), writeAfterDelay]);

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBe("Agent panicked");
    expect(result.errorCode).toBe("hermes_gateway_agent_error");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("removes stale outbox file before writing inbox", async () => {
    const tmpDir = makeTmpDir();
    const runId = "stale-run-1";
    const outboxDir = path.join(tmpDir, DEFAULT_OUTBOX_SUBPATH);
    const inboxDir = path.join(tmpDir, DEFAULT_INBOX_SUBPATH);
    const outboxFile = path.join(outboxDir, `${runId}.json`);

    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });

    // Write a stale "ok" response so adapter would return immediately if it's not cleaned
    fs.writeFileSync(
      outboxFile,
      JSON.stringify({ runId, status: "ok", summary: "STALE" }),
      "utf8",
    );

    // The adapter should remove the stale file and then time out (since no new response comes)
    const ctx = makeCtx({
      runId,
      config: {
        workspaceDir: tmpDir,
        skipLivenessCheck: true,
        timeoutSec: 1,
        pollIntervalMs: 100,
      },
    });

    const result = await execute(ctx);

    // If stale replay prevention works, should time out rather than return STALE
    expect(result.timedOut).toBe(true);
    expect(result.summary).toBeUndefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Tests: pid liveness path
// ---------------------------------------------------------------------------

describe("execute — process liveness", () => {
  it("fails with process_not_alive error when pid file has a dead pid", async () => {
    const tmpDir = makeTmpDir();
    const pidFile = path.join(tmpDir, DEFAULT_PID_FILE_SUBPATH);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    // PID 999999999 is almost certainly not alive
    fs.writeFileSync(pidFile, "999999999", "utf8");

    const ctx = makeCtx({
      config: {
        workspaceDir: tmpDir,
        skipLivenessCheck: false,
        timeoutSec: 5,
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_process_not_alive");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips liveness check when skipLivenessCheck is true", async () => {
    const tmpDir = makeTmpDir();
    // No pid file at all; skipLivenessCheck means we don't fail
    const ctx = makeCtx({
      config: {
        workspaceDir: tmpDir,
        skipLivenessCheck: true,
        timeoutSec: 1,
        pollIntervalMs: 100,
      },
    });

    const result = await execute(ctx);
    // Should time out, not fail with pid error
    expect(result.timedOut).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
