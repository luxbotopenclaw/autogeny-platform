/**
 * Tests for the static analysis gate service.
 *
 * Uses real filesystem temporary directories + an injected _toolRunner so
 * no real tsc/eslint/semgrep binaries are required in CI.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolRunner } from "../services/static-analysis-gate.ts";
import { runStaticAnalysisGate, readStaticAnalysisConfig } from "../services/static-analysis-gate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "static-gate-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A tool runner that always succeeds (exit 0). */
function successRunner(): ToolRunner {
  return async (_cmd, _args, _cwd) => ({ exitCode: 0, stdout: "", stderr: "" });
}

/**
 * A tool runner where specific tools fail.
 * Key is the first argument after the binary (e.g. "tsc", "eslint", "--config=auto").
 */
function selectiveRunner(
  failOn: Record<string, { exitCode: number; stdout?: string; stderr?: string }>,
): ToolRunner {
  return async (_cmd, args, _cwd) => {
    const toolArg = args[0] ?? "";
    const failure = failOn[toolArg];
    if (failure) {
      return { exitCode: failure.exitCode, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

/** A tool runner that captures all invocations for inspection. */
function capturingRunner(): {
  runner: ToolRunner;
  calls: Array<{ cmd: string; args: string[]; cwd: string }>;
} {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const runner: ToolRunner = async (cmd, args, cwd) => {
    calls.push({ cmd, args: [...args], cwd });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// readStaticAnalysisConfig — pure function tests (no I/O)
// ---------------------------------------------------------------------------

describe("readStaticAnalysisConfig", () => {
  it("returns enabled defaults when metadata is null", () => {
    const cfg = readStaticAnalysisConfig(null);
    expect(cfg.enabled).toBe(true);
    expect(cfg.tsc.enabled).toBe(true);
    expect(cfg.eslint.enabled).toBe(true);
    expect(cfg.semgrep.enabled).toBe(false);
  });

  it("returns enabled defaults when metadata has no staticAnalysis key", () => {
    const cfg = readStaticAnalysisConfig({ foo: "bar" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.tsc.enabled).toBe(true);
    expect(cfg.eslint.enabled).toBe(true);
    expect(cfg.semgrep.enabled).toBe(false);
  });

  it("respects master enabled=false", () => {
    const cfg = readStaticAnalysisConfig({ staticAnalysis: { enabled: false } });
    expect(cfg.enabled).toBe(false);
  });

  it("respects per-tool enabled flags", () => {
    const cfg = readStaticAnalysisConfig({
      staticAnalysis: {
        enabled: true,
        tsc: { enabled: false },
        eslint: { enabled: true },
        semgrep: { enabled: true },
      },
    });
    expect(cfg.tsc.enabled).toBe(false);
    expect(cfg.eslint.enabled).toBe(true);
    expect(cfg.semgrep.enabled).toBe(true);
  });

  it("handles non-object staticAnalysis gracefully", () => {
    const cfg = readStaticAnalysisConfig({ staticAnalysis: "not_an_object" });
    expect(cfg.enabled).toBe(true);
  });

  it("reads custom args from config", () => {
    const cfg = readStaticAnalysisConfig({
      staticAnalysis: { tsc: { enabled: true, args: ["--strict"] } },
    });
    expect(cfg.tsc.args).toEqual(["--strict"]);
  });
});

// ---------------------------------------------------------------------------
// runStaticAnalysisGate — gate skipping
// ---------------------------------------------------------------------------

describe("runStaticAnalysisGate — gate skipping", () => {
  it("skips when workspace path does not exist", async () => {
    const result = await runStaticAnalysisGate({
      workspacePath: "/nonexistent/path/abc12345xyz",
      projectWorkspaceMetadata: null,
      _toolRunner: successRunner(),
    });
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.failureSummary).toBeNull();
  });

  it("skips when workspace path is a file, not a directory", async () => {
    const filePath = path.join(tmpDir, "notadir.txt");
    await fs.writeFile(filePath, "hello");
    const result = await runStaticAnalysisGate({
      workspacePath: filePath,
      projectWorkspaceMetadata: null,
      _toolRunner: successRunner(),
    });
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("skips when config.enabled is false", async () => {
    const result = await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: { staticAnalysis: { enabled: false } },
      _toolRunner: successRunner(),
    });
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.failureSummary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runStaticAnalysisGate — tool execution
// ---------------------------------------------------------------------------

describe("runStaticAnalysisGate — tool execution", () => {
  it("returns passed=true when tsc and eslint both succeed (exit 0)", async () => {
    const result = await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
      _toolRunner: successRunner(),
    });

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.failureSummary).toBeNull();
    const tools = result.results.map((r) => r.tool);
    expect(tools).toContain("tsc");
    expect(tools).toContain("eslint");
    // semgrep is disabled by default
    expect(tools).not.toContain("semgrep");
  });

  it("tsc errors block merge (passed=false, exitCode non-zero)", async () => {
    const result = await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
      _toolRunner: selectiveRunner({
        tsc: { exitCode: 1, stdout: "error TS2322: Type 'string' is not assignable to type 'number'\n" },
      }),
    });

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.failureSummary).not.toBeNull();
    expect(result.failureSummary).toContain("tsc");
    expect(result.failureSummary).toContain("TS2322");

    const tscResult = result.results.find((r) => r.tool === "tsc");
    expect(tscResult?.passed).toBe(false);
    expect(tscResult?.exitCode).toBe(1);
    expect(tscResult?.skipped).toBe(false);
  });

  it("eslint warnings block merge (passed=false, exit code 1)", async () => {
    const result = await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
      _toolRunner: selectiveRunner({
        eslint: { exitCode: 1, stdout: "1:1  warning  'x' is defined but never used\n1 problem\n" },
      }),
    });

    expect(result.passed).toBe(false);
    const eslintResult = result.results.find((r) => r.tool === "eslint");
    expect(eslintResult?.passed).toBe(false);
    expect(eslintResult?.exitCode).toBe(1);
  });

  it("both tsc and eslint failures appear in failureSummary", async () => {
    const result = await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
      _toolRunner: selectiveRunner({
        tsc: { exitCode: 1, stdout: "error TS1000\n" },
        eslint: { exitCode: 1, stdout: "1 warning\n" },
      }),
    });

    expect(result.passed).toBe(false);
    expect(result.failureSummary).toContain("tsc");
    expect(result.failureSummary).toContain("eslint");
  });

  it("semgrep is disabled by default and not invoked", async () => {
    const { runner, calls } = capturingRunner();
    await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
      _toolRunner: runner,
    });

    expect(calls.some((c) => c.args.includes("--config=auto"))).toBe(false);
    expect(calls.some((c) => c.cmd === "semgrep")).toBe(false);
  });

  it("semgrep runs when explicitly enabled and binary exists (mocked via toolRunner)", async () => {
    // When semgrep is enabled and the binary is found (toolExists uses real execFile),
    // the _toolRunner is invoked for the actual scan. On CI semgrep may not exist,
    // so we accept either passed (via runner) or skipped (binary not found).
    const result = await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: { staticAnalysis: { semgrep: { enabled: true } } },
      _toolRunner: successRunner(),
    });

    const semgrepResult = result.results.find((r) => r.tool === "semgrep");
    expect(semgrepResult).toBeDefined();
    // Either ran (passed=true, skipped=false) or skipped because binary not found
    if (!semgrepResult?.skipped) {
      expect(semgrepResult?.passed).toBe(true);
    }
  });

  it("filters out unsafe args — only safe args reach the tool", async () => {
    const { runner, calls } = capturingRunner();
    await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: {
        staticAnalysis: {
          tsc: { enabled: true, args: ["--strict", "; rm -rf /", "$(evil)", "--incremental"] },
          eslint: { enabled: false },
        },
      },
      _toolRunner: runner,
    });

    const tscCall = calls.find((c) => c.args.includes("tsc"));
    expect(tscCall).toBeDefined();
    expect(tscCall?.args).toContain("--strict");
    expect(tscCall?.args).toContain("--incremental");
    // Injection attempts are filtered out
    expect(tscCall?.args.some((a) => a.includes("rm"))).toBe(false);
    expect(tscCall?.args.some((a) => a.includes("$("))).toBe(false);
    expect(tscCall?.args.some((a) => a.includes(";"))).toBe(false);
  });

  it("failure output appears as issue comment (failureSummary is well-formed Markdown)", async () => {
    const result = await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: null,
      _toolRunner: selectiveRunner({
        tsc: { exitCode: 2, stdout: "error TS1000: Unexpected token\n" },
      }),
    });

    expect(result.failureSummary).toMatch(/## ⛔ Static Analysis Gate Failed/);
    expect(result.failureSummary).toMatch(/`tsc`/);
    expect(result.failureSummary).toMatch(/TS1000/);
    expect(result.failureSummary).toMatch(/Fix the errors above/);
  });

  it("prevents path traversal in tool cwd config", async () => {
    const { runner, calls } = capturingRunner();
    await runStaticAnalysisGate({
      workspacePath: tmpDir,
      projectWorkspaceMetadata: {
        staticAnalysis: {
          tsc: { enabled: true, cwd: "../../etc" },
          eslint: { enabled: false },
        },
      },
      _toolRunner: runner,
    });

    const tscCall = calls.find((c) => c.args.includes("tsc"));
    expect(tscCall).toBeDefined();
    // Traversal is blocked; cwd must be the workspace root
    expect(tscCall?.cwd).toBe(tmpDir);
  });
});
