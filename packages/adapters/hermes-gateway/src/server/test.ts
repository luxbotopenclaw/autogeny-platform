/**
 * Hermes Gateway Adapter — environment test / health check.
 *
 * Checks:
 *   1. workspaceDir is configured and accessible.
 *   2. inboxDir is writable (or can be created).
 *   3. pidFile presence and process liveness (kill -0).
 *   4. OPENROUTER_API_KEY or ANTHROPIC_API_KEY is present (advisory only).
 */

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  DEFAULT_WORKSPACE_DIR,
  DEFAULT_INBOX_SUBPATH,
  DEFAULT_OUTBOX_SUBPATH,
  DEFAULT_PID_FILE_SUBPATH,
} from "../shared/constants.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function resolveDir(configValue: unknown, workspaceDir: string, subpath: string): string {
  const raw = nonEmpty(configValue);
  if (raw) {
    const expanded = expandHome(raw);
    if (path.isAbsolute(expanded)) return expanded;
  }
  return path.join(workspaceDir, subpath);
}

function resolveWorkspaceDir(config: Record<string, unknown>): string {
  const fromConfig = nonEmpty(config.workspaceDir);
  if (fromConfig) return expandHome(fromConfig);
  const fromEnv = nonEmpty(process.env["HERMES_WORKSPACE"]);
  if (fromEnv) return expandHome(fromEnv);
  return expandHome(DEFAULT_WORKSPACE_DIR);
}

function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function isDirAccessible(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function canCreateDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const workspaceDir = resolveWorkspaceDir(config);
  const inboxDir = resolveDir(config.inboxDir, workspaceDir, DEFAULT_INBOX_SUBPATH);
  const outboxDir = resolveDir(config.outboxDir, workspaceDir, DEFAULT_OUTBOX_SUBPATH);
  const pidFile = resolveDir(config.pidFile, workspaceDir, DEFAULT_PID_FILE_SUBPATH);

  // ── Workspace dir ────────────────────────────────────────────────────────
  checks.push({
    code: "hermes_gateway_workspace_dir",
    level: "info",
    message: `Workspace directory: ${workspaceDir}`,
  });

  // ── Inbox dir ─────────────────────────────────────────────────────────────
  if (isDirAccessible(inboxDir)) {
    checks.push({
      code: "hermes_gateway_inbox_accessible",
      level: "info",
      message: `Inbox directory is accessible: ${inboxDir}`,
    });
  } else if (canCreateDir(inboxDir)) {
    checks.push({
      code: "hermes_gateway_inbox_created",
      level: "info",
      message: `Inbox directory created: ${inboxDir}`,
    });
  } else {
    checks.push({
      code: "hermes_gateway_inbox_not_writable",
      level: "error",
      message: `Inbox directory is not accessible and could not be created: ${inboxDir}`,
      hint: "Ensure the Paperclip server process has write access to this directory.",
    });
  }

  // ── Outbox dir ────────────────────────────────────────────────────────────
  if (isDirAccessible(outboxDir)) {
    checks.push({
      code: "hermes_gateway_outbox_accessible",
      level: "info",
      message: `Outbox directory is accessible: ${outboxDir}`,
    });
  } else if (canCreateDir(outboxDir)) {
    checks.push({
      code: "hermes_gateway_outbox_created",
      level: "info",
      message: `Outbox directory created: ${outboxDir}`,
    });
  } else {
    checks.push({
      code: "hermes_gateway_outbox_not_writable",
      level: "warn",
      message: `Outbox directory is not accessible: ${outboxDir}`,
      hint: "Hermes will write response files here; ensure the directory is writable by the Hermes process.",
    });
  }

  // ── Process liveness ──────────────────────────────────────────────────────
  if (!fs.existsSync(pidFile)) {
    checks.push({
      code: "hermes_gateway_pid_file_missing",
      level: "warn",
      message: `Hermes pid file not found: ${pidFile}`,
      hint: "Start the Hermes runtime and ensure pidFile config points to its pid file.",
    });
  } else {
    const pid = readPidFile(pidFile);
    if (pid === null) {
      checks.push({
        code: "hermes_gateway_pid_file_invalid",
        level: "warn",
        message: `Hermes pid file exists but could not be parsed: ${pidFile}`,
        hint: "The file should contain a single integer process ID.",
      });
    } else {
      const alive = isProcessAlive(pid);
      if (alive) {
        checks.push({
          code: "hermes_gateway_process_alive",
          level: "info",
          message: `Hermes process is alive (pid=${pid}).`,
        });
      } else {
        checks.push({
          code: "hermes_gateway_process_not_alive",
          level: "warn",
          message: `Hermes pid file found (pid=${pid}) but process is not running.`,
          hint: "Start the Hermes runtime before triggering agent runs.",
        });
      }
    }
  }

  // ── LLM API keys (advisory) ───────────────────────────────────────────────
  const hasOpenRouter = Boolean(nonEmpty(process.env["OPENROUTER_API_KEY"]));
  const hasAnthropic = Boolean(nonEmpty(process.env["ANTHROPIC_API_KEY"]));
  if (hasOpenRouter || hasAnthropic) {
    checks.push({
      code: "hermes_gateway_llm_key_present",
      level: "info",
      message: `LLM API key detected: ${[hasOpenRouter ? "OPENROUTER_API_KEY" : null, hasAnthropic ? "ANTHROPIC_API_KEY" : null].filter(Boolean).join(", ")}.`,
    });
  } else {
    checks.push({
      code: "hermes_gateway_llm_key_missing",
      level: "warn",
      message: "No OPENROUTER_API_KEY or ANTHROPIC_API_KEY found in environment.",
      hint: "Set one of these env vars in the Hermes config or the Paperclip server environment.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
