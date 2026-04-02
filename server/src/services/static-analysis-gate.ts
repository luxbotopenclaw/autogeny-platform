import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { StaticAnalysisConfig, StaticAnalysisGateResult, StaticAnalysisToolResult } from "@paperclipai/shared";
const execFileAsync = promisify(execFile);
const TOOL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SAFE_ARG_PATTERN = /^[a-zA-Z0-9_./:@=\-]+$/;
function validateArgs(args: string[] | undefined): string[] {
  if (!Array.isArray(args)) return [];
  return args.filter((arg) => typeof arg === "string" && SAFE_ARG_PATTERN.test(arg));
}
function truncate(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MAX_OUTPUT_BYTES) return s;
  return Buffer.from(s, "utf8").slice(0, MAX_OUTPUT_BYTES).toString("utf8") + "\n… (output truncated)";
}
export function readStaticAnalysisConfig(metadata: Record<string, unknown> | null | undefined): StaticAnalysisConfig {
  const defaults: StaticAnalysisConfig = { enabled: true, tsc: { enabled: true }, eslint: { enabled: true }, semgrep: { enabled: false } };
  const raw = metadata?.staticAnalysis;
  if (typeof raw !== "object" || raw === null) return defaults;
  const cfg = raw as Record<string, unknown>;
  function readToolConfig(key: "tsc" | "eslint" | "semgrep", defaultEnabled: boolean) {
    const tool = cfg[key];
    if (typeof tool !== "object" || tool === null) return { enabled: defaultEnabled };
    const t = tool as Record<string, unknown>;
    return { enabled: typeof t.enabled === "boolean" ? t.enabled : defaultEnabled, args: Array.isArray(t.args) ? (t.args as unknown[]).filter((a): a is string => typeof a === "string") : undefined, cwd: typeof t.cwd === "string" ? t.cwd : undefined };
  }
  return { enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : true, tsc: readToolConfig("tsc", true), eslint: readToolConfig("eslint", true), semgrep: readToolConfig("semgrep", false) };
}
async function resolveToolCwd(workspacePath: string, relativeCwd?: string): Promise<string> {
  if (!relativeCwd) return workspacePath;
  const resolved = path.resolve(workspacePath, relativeCwd);
  if (!resolved.startsWith(workspacePath + path.sep) && resolved !== workspacePath) return workspacePath;
  try { const stat = await fs.stat(resolved); if (stat.isDirectory()) return resolved; } catch {}
  return workspacePath;
}
async function runTool(cmd: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: TOOL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES * 2 });
    return { exitCode: 0, stdout: truncate(stdout), stderr: truncate(stderr) };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    const exitCode = typeof e.code === "number" ? e.code : (e.killed ? 124 : 1);
    return { exitCode, stdout: truncate(typeof e.stdout === "string" ? e.stdout : ""), stderr: truncate(typeof e.stderr === "string" ? e.stderr : "") };
  }
}
async function toolExists(cmd: string): Promise<boolean> {
  try { await execFileAsync(cmd, ["--version"], { timeout: 5000 }); return true; }
  catch (e) { const err = e as { code?: number | string }; if (err.code === "ENOENT" || err.code === "EACCES") return false; return true; }
}
function buildFailureSummary(results: StaticAnalysisToolResult[]): string | null {
  const failed = results.filter((r) => !r.passed && !r.skipped);
  if (failed.length === 0) return null;
  const lines: string[] = ["## ⛔ Static Analysis Gate Failed", "", "The following checks failed and blocked the workspace merge:", ""];
  for (const r of failed) {
    lines.push(`### \`${r.tool}\` (exit code ${r.exitCode})`, "");
    if (r.stdout.trim()) { lines.push("**stdout:**", "```", r.stdout.trim(), "```"); }
    if (r.stderr.trim()) { lines.push("**stderr:**", "```", r.stderr.trim(), "```"); }
    lines.push("");
  }
  lines.push("Fix the errors above and retry closing the workspace.");
  return lines.join("\n");
}
export type ToolRunner = (cmd: string, args: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export async function runStaticAnalysisGate(options: { workspacePath: string; projectWorkspaceMetadata: Record<string, unknown> | null | undefined; _toolRunner?: ToolRunner; }): Promise<StaticAnalysisGateResult> {
  const { workspacePath, projectWorkspaceMetadata, _toolRunner } = options;
  const runner: ToolRunner = _toolRunner ?? runTool;
  try { const stat = await fs.stat(workspacePath); if (!stat.isDirectory()) return { passed: true, skipped: true, results: [], failureSummary: null }; }
  catch { return { passed: true, skipped: true, results: [], failureSummary: null }; }
  const config = readStaticAnalysisConfig(projectWorkspaceMetadata);
  if (!config.enabled) return { passed: true, skipped: true, results: [], failureSummary: null };
  const results: StaticAnalysisToolResult[] = [];
  if (config.tsc.enabled) {
    const cwd = await resolveToolCwd(workspacePath, config.tsc.cwd);
    const extraArgs = validateArgs(config.tsc.args);
    const start = Date.now();
    const { exitCode, stdout, stderr } = await runner("npx", ["tsc", "--noEmit", ...extraArgs], cwd);
    results.push({ tool: "tsc", passed: exitCode === 0, exitCode, stdout, stderr, durationMs: Date.now() - start, skipped: false });
  }
  if (config.eslint.enabled) {
    const cwd = await resolveToolCwd(workspacePath, config.eslint.cwd);
    const extraArgs = validateArgs(config.eslint.args);
    const start = Date.now();
    const { exitCode, stdout, stderr } = await runner("npx", ["eslint", "--max-warnings", "0", ".", ...extraArgs], cwd);
    results.push({ tool: "eslint", passed: exitCode === 0, exitCode, stdout, stderr, durationMs: Date.now() - start, skipped: false });
  }
  if (config.semgrep.enabled) {
    const semgrepExists = await toolExists("semgrep");
    if (!semgrepExists) {
      results.push({ tool: "semgrep", passed: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, skipped: true, skipReason: "semgrep binary not found; skipping" });
    } else {
      const cwd = await resolveToolCwd(workspacePath, config.semgrep.cwd);
      const extraArgs = validateArgs(config.semgrep.args);
      const start = Date.now();
      const { exitCode, stdout, stderr } = await runner("semgrep", ["--config=auto", ".", ...extraArgs], cwd);
      results.push({ tool: "semgrep", passed: exitCode === 0, exitCode, stdout, stderr, durationMs: Date.now() - start, skipped: false });
    }
  }
  const allPassed = results.every((r) => r.passed);
  return { passed: allPassed, skipped: false, results, failureSummary: allPassed ? null : buildFailureSummary(results) };
}
