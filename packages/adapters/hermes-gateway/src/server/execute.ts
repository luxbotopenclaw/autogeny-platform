/**
 * Hermes Gateway Adapter — server-side execution.
 *
 * Protocol:
 *   1. Resolve config (inboxDir, outboxDir, pidFile, timeoutSec).
 *   2. Optionally verify Hermes process liveness via kill -0 <pid>.
 *   3. Ensure inboxDir exists, clean up any stale outbox file for this runId.
 *   4. Write {runId}.json wake message to inboxDir.
 *   5. Poll outboxDir/{runId}.json until the response appears or timeout.
 *   6. Parse the response and return AdapterExecutionResult.
 *
 * Security:
 *   - inboxDir and outboxDir are validated to be absolute paths; no
 *     user-supplied path segments are joined after them.
 *   - The inbox payload is constructed entirely from trusted adapter context;
 *     no user content is shell-interpolated.
 *   - Stale outbox files from prior runs are removed before writing the wake
 *     message to prevent replay of old results.
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, buildPaperclipEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import {
  ADAPTER_TYPE,
  DEFAULT_WORKSPACE_DIR,
  DEFAULT_INBOX_SUBPATH,
  DEFAULT_OUTBOX_SUBPATH,
  DEFAULT_PID_FILE_SUBPATH,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_POLL_INTERVAL_MS,
  INBOX_MESSAGE_VERSION,
  LOG_PREFIX,
  LOG_PREFIX_EVENT,
} from "../shared/constants.js";

// ---------------------------------------------------------------------------
// Small utilities (no external deps)
// ---------------------------------------------------------------------------

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Resolve a directory from config.  Accepts an absolute path or ~/… shorthand.
 * Falls back to joining workspaceDir + subpath when the config key is absent.
 */
function resolveDir(configValue: unknown, workspaceDir: string, subpath: string): string {
  const raw = nonEmpty(configValue);
  if (raw) {
    const expanded = expandHome(raw);
    if (path.isAbsolute(expanded)) return expanded;
  }
  return path.join(workspaceDir, subpath);
}

/**
 * Resolve the workspace root.  Prefers explicit config; falls back to env
 * HERMES_WORKSPACE or the compiled default.
 */
function resolveWorkspaceDir(config: Record<string, unknown>): string {
  const fromConfig = nonEmpty(config.workspaceDir);
  if (fromConfig) return expandHome(fromConfig);
  const fromEnv = nonEmpty(process.env["HERMES_WORKSPACE"]);
  if (fromEnv) return expandHome(fromEnv);
  return expandHome(DEFAULT_WORKSPACE_DIR);
}

/** Safely read an integer PID from a text file. */
function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Check whether a process is alive using signal 0 (POSIX). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission → alive
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/** Ensure a directory exists, creating it (and parents) if needed. */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Remove a file silently (ignore ENOENT). */
function removeFileSilent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/** Write JSON atomically via a temp file + rename. */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/** Read and parse a JSON file.  Returns null on any error. */
function readJsonSilent(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Paperclip env / wake payload helpers  (mirrors openclaw-gateway pattern)
// ---------------------------------------------------------------------------

type WakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

function buildWakePayload(ctx: AdapterExecutionContext): WakePayload {
  const { runId, agent, context } = ctx;
  return {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

function resolvePaperclipApiUrl(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildPaperclipEnvForWake(ctx: AdapterExecutionContext, wake: WakePayload): Record<string, string> {
  const paperclipApiUrl = resolvePaperclipApiUrl(ctx.config.paperclipApiUrl);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
  };
  if (paperclipApiUrl) paperclipEnv.PAPERCLIP_API_URL = paperclipApiUrl;
  if (wake.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wake.taskId;
  if (wake.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wake.wakeReason;
  if (wake.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wake.wakeCommentId;
  if (wake.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wake.approvalId;
  if (wake.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wake.approvalStatus;
  if (wake.issueIds.length > 0) paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wake.issueIds.join(",");
  return paperclipEnv;
}

function buildStandardPaperclipPayload(
  ctx: AdapterExecutionContext,
  wake: WakePayload,
  paperclipEnv: Record<string, string>,
  template: Record<string, unknown>,
): Record<string, unknown> {
  const templatePaperclip = parseObject(template.paperclip);
  const workspace = asRecord(ctx.context.paperclipWorkspace);
  const workspaces = Array.isArray(ctx.context.paperclipWorkspaces)
    ? ctx.context.paperclipWorkspaces.filter((e): e is Record<string, unknown> => Boolean(asRecord(e)))
    : [];

  const standard: Record<string, unknown> = {
    runId: ctx.runId,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    taskId: wake.taskId,
    issueId: wake.issueId,
    issueIds: wake.issueIds,
    wakeReason: wake.wakeReason,
    wakeCommentId: wake.wakeCommentId,
    approvalId: wake.approvalId,
    approvalStatus: wake.approvalStatus,
    apiUrl: paperclipEnv.PAPERCLIP_API_URL ?? null,
  };
  if (workspace) standard.workspace = workspace;
  if (workspaces.length > 0) standard.workspaces = workspaces;

  return { ...templatePaperclip, ...standard };
}

/** Build the human-readable wake text injected into the Hermes inbox message. */
function buildWakeText(wake: WakePayload, paperclipEnv: Record<string, string>): string {
  const claimedApiKeyPath = "~/.hermes/paperclip-claimed-api-key.json";
  const orderedKeys = [
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WAKE_COMMENT_ID",
    "PAPERCLIP_APPROVAL_ID",
    "PAPERCLIP_APPROVAL_STATUS",
    "PAPERCLIP_LINKED_ISSUE_IDS",
  ];
  const envLines: string[] = [];
  for (const key of orderedKeys) {
    const value = paperclipEnv[key];
    if (value) envLines.push(`${key}=${value}`);
  }

  const issueIdHint = wake.taskId ?? wake.issueId ?? "";
  const apiBaseHint = paperclipEnv.PAPERCLIP_API_URL ?? "<set PAPERCLIP_API_URL>";

  const lines = [
    "Paperclip wake event for the Hermes gateway adapter.",
    "",
    "Run this procedure now.",
    "",
    "Set these values in your run context:",
    ...envLines,
    `PAPERCLIP_API_KEY=<token from ${claimedApiKeyPath}>`,
    "",
    `Load PAPERCLIP_API_KEY from ${claimedApiKeyPath}.`,
    "",
    `api_base=${apiBaseHint}`,
    `task_id=${wake.taskId ?? ""}`,
    `issue_id=${wake.issueId ?? ""}`,
    `wake_reason=${wake.wakeReason ?? ""}`,
    `wake_comment_id=${wake.wakeCommentId ?? ""}`,
    `approval_id=${wake.approvalId ?? ""}`,
    `approval_status=${wake.approvalStatus ?? ""}`,
    `linked_issue_ids=${wake.issueIds.join(",")}`,
    "",
    "HTTP rules:",
    "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating API call.",
    "",
    "Workflow:",
    "1) GET /api/agents/me",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    `   - POST /api/issues/{issueId}/checkout with {"agentId":"$PAPERCLIP_AGENT_ID","expectedStatuses":["todo","backlog","blocked"]}`,
    "   - GET /api/issues/{issueId}",
    "   - GET /api/issues/{issueId}/comments",
    "   - Execute the issue instructions exactly.",
    "   - If instructions require a comment, POST /api/issues/{issueId}/comments.",
    `   - PATCH /api/issues/{issueId} with {"status":"done","comment":"what changed and why"}.`,
    "4) If issueId does not exist:",
    "   - GET /api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID&status=todo,in_progress,blocked",
    "   - Pick in_progress first, then todo, then blocked, then execute step 3.",
    "",
    "Complete the workflow in this run.",
  ];
  return lines.join("\n");
}

function appendWakeText(base: string, wakeText: string): string {
  const trimmed = base.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${wakeText}` : wakeText;
}

// ---------------------------------------------------------------------------
// Outbox response parsing
// ---------------------------------------------------------------------------

type OutboxResponse = {
  status: "ok" | "error" | "timeout";
  summary: string | null;
  exitCode: number;
  error: string | null;
  model: string | null;
  provider: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  } | null;
  costUsd: number | null;
};

function parseOutboxResponse(data: Record<string, unknown>): OutboxResponse {
  const status = (nonEmpty(data.status) ?? "ok").toLowerCase();
  const normalizedStatus: OutboxResponse["status"] =
    status === "error" ? "error" : status === "timeout" ? "timeout" : "ok";

  const usageRaw = asRecord(data.usage);
  let usage: OutboxResponse["usage"] = null;
  if (usageRaw) {
    const inp = asNumber(usageRaw.inputTokens ?? usageRaw.input_tokens, 0);
    const out = asNumber(usageRaw.outputTokens ?? usageRaw.output_tokens, 0);
    const cache = asNumber(
      usageRaw.cachedInputTokens ?? usageRaw.cached_input_tokens ?? usageRaw.cacheRead,
      0,
    );
    if (inp > 0 || out > 0 || cache > 0) {
      usage = { inputTokens: inp, outputTokens: out };
      if (cache > 0) usage.cachedInputTokens = cache;
    }
  }

  return {
    status: normalizedStatus,
    summary: nonEmpty(data.summary) ?? nonEmpty(data.text) ?? nonEmpty(data.result),
    exitCode: typeof data.exitCode === "number" ? data.exitCode : normalizedStatus === "ok" ? 0 : 1,
    error: nonEmpty(data.error) ?? nonEmpty(data.errorMessage),
    model: nonEmpty(data.model),
    provider: nonEmpty(data.provider) ?? "hermes",
    usage,
    costUsd: typeof data.costUsd === "number" && Number.isFinite(data.costUsd) ? data.costUsd : null,
  };
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const workspaceDir = resolveWorkspaceDir(config);

  const inboxDir = resolveDir(config.inboxDir, workspaceDir, DEFAULT_INBOX_SUBPATH);
  const outboxDir = resolveDir(config.outboxDir, workspaceDir, DEFAULT_OUTBOX_SUBPATH);
  const pidFile = resolveDir(config.pidFile, workspaceDir, DEFAULT_PID_FILE_SUBPATH);

  // Enforce a minimum timeout: 0 would create an infinite poll loop.
  const rawTimeoutSec = Math.floor(asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC));
  const timeoutSec = rawTimeoutSec > 0 ? rawTimeoutSec : DEFAULT_TIMEOUT_SEC;
  const timeoutMs = timeoutSec * 1000;
  const pollIntervalMs = Math.max(
    100,
    Math.floor(asNumber(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)),
  );

  const skipLivenessCheck = config.skipLivenessCheck === true;

  // ── Validate paths are absolute (security: prevent path traversal) ──────
  if (!path.isAbsolute(inboxDir)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `hermes-gateway inboxDir is not absolute: ${inboxDir}`,
      errorCode: "hermes_gateway_inbox_path_invalid",
    };
  }
  if (!path.isAbsolute(outboxDir)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `hermes-gateway outboxDir is not absolute: ${outboxDir}`,
      errorCode: "hermes_gateway_outbox_path_invalid",
    };
  }

  // ── Process liveness check ───────────────────────────────────────────────
  if (!skipLivenessCheck) {
    const pid = readPidFile(pidFile);
    if (pid === null) {
      await ctx.onLog(
        "stdout",
        `${LOG_PREFIX} pid file not found or unreadable at ${pidFile}; skipping liveness check\n`,
      );
    } else {
      const alive = isProcessAlive(pid);
      await ctx.onLog(
        "stdout",
        `${LOG_PREFIX} liveness check pid=${pid} alive=${alive}\n`,
      );
      if (!alive) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Hermes process (pid ${pid}) is not running. Start the Hermes runtime before triggering agent runs.`,
          errorCode: "hermes_gateway_process_not_alive",
        };
      }
    }
  }

  // ── Build wake message ───────────────────────────────────────────────────
  const payloadTemplate = parseObject(config.payloadTemplate);
  const wake = buildWakePayload(ctx);
  const paperclipEnv = buildPaperclipEnvForWake(ctx, wake);
  const wakeText = buildWakeText(wake, paperclipEnv);
  const paperclipPayload = buildStandardPaperclipPayload(ctx, wake, paperclipEnv, payloadTemplate);

  const templateMessage = nonEmpty(payloadTemplate.message) ?? nonEmpty(payloadTemplate.text);
  const message = templateMessage ? appendWakeText(templateMessage, wakeText) : wakeText;

  const inboxMessage: Record<string, unknown> = {
    version: INBOX_MESSAGE_VERSION,
    runId: ctx.runId,
    agentId: wake.agentId,
    companyId: wake.companyId,
    taskId: wake.taskId,
    issueId: wake.issueId,
    issueIds: wake.issueIds,
    wakeReason: wake.wakeReason,
    wakeCommentId: wake.wakeCommentId,
    approvalId: wake.approvalId,
    approvalStatus: wake.approvalStatus,
    message,
    paperclip: paperclipPayload,
    env: paperclipEnv,
    sentAt: new Date().toISOString(),
  };

  // Sanitize runId before use as path component (defense-in-depth; runId is
  // platform-generated but we guard against any accidental traversal).
  const safeRunId = path.basename(ctx.runId).replace(/[^A-Za-z0-9_\-.]/g, "");
  if (!safeRunId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `hermes-gateway: runId is empty or contains only unsafe characters: ${ctx.runId}`,
      errorCode: "hermes_gateway_run_id_invalid",
    };
  }

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: ADAPTER_TYPE,
      command: "hermes",
      commandArgs: ["inbox", inboxDir, ctx.runId],
      context: ctx.context,
    });
  }

  // ── Ensure inbox/outbox directories exist ────────────────────────────────
  try {
    ensureDir(inboxDir);
    ensureDir(outboxDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `hermes-gateway failed to create inbox/outbox dirs: ${message}`,
      errorCode: "hermes_gateway_dir_create_failed",
    };
  }

  // ── Remove stale outbox file for this run (prevent replay) ──────────────
  const outboxFile = path.join(outboxDir, `${safeRunId}.json`);
  removeFileSilent(outboxFile);

  // ── Write wake message to inbox ──────────────────────────────────────────
  const inboxFile = path.join(inboxDir, `${safeRunId}.json`);
  try {
    writeJsonAtomic(inboxFile, inboxMessage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `hermes-gateway failed to write inbox message: ${message}`,
      errorCode: "hermes_gateway_inbox_write_failed",
    };
  }

  await ctx.onLog("stdout", `${LOG_PREFIX} wake message written to ${inboxFile}\n`);
  await ctx.onLog("stdout", `${LOG_PREFIX} polling for response at ${outboxFile}\n`);

  // ── Poll outbox for response ──────────────────────────────────────────────
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  let response: Record<string, unknown> | null = null;

  while (true) {
    response = readJsonSilent(outboxFile);
    if (response !== null) break;

    if (deadline > 0 && Date.now() >= deadline) {
      await ctx.onLog(
        "stdout",
        `${LOG_PREFIX} timed out waiting for response after ${timeoutSec}s\n`,
      );
      // Clean up the inbox file so Hermes doesn't process stale messages
      removeFileSilent(inboxFile);
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorMessage: `Hermes gateway run timed out after ${timeoutSec}s`,
        errorCode: "hermes_gateway_timeout",
      };
    }

    await sleep(pollIntervalMs);
  }

  // ── Parse and return result ──────────────────────────────────────────────
  const parsed = parseOutboxResponse(response);

  await ctx.onLog(
    "stdout",
    `${LOG_PREFIX_EVENT} run=${ctx.runId} stream=lifecycle data=${JSON.stringify({ phase: parsed.status, model: parsed.model })}\n`,
  );

  if (parsed.status === "error") {
    return {
      exitCode: parsed.exitCode,
      signal: null,
      timedOut: false,
      errorMessage: parsed.error ?? "Hermes agent returned an error",
      errorCode: "hermes_gateway_agent_error",
      resultJson: response,
    };
  }

  if (parsed.status === "timeout") {
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorMessage: "Hermes agent reported a timeout",
      errorCode: "hermes_gateway_agent_timeout",
      resultJson: response,
    };
  }

  await ctx.onLog(
    "stdout",
    `${LOG_PREFIX} run completed runId=${ctx.runId} status=ok\n`,
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: parsed.provider ?? "hermes",
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    ...(parsed.costUsd != null && parsed.costUsd > 0 ? { costUsd: parsed.costUsd } : {}),
    resultJson: response,
    ...(parsed.summary ? { summary: parsed.summary } : {}),
  };
}
