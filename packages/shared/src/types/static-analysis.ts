export interface StaticAnalysisToolConfig {
  enabled: boolean;
  args?: string[];
  cwd?: string;
}
export interface StaticAnalysisConfig {
  enabled: boolean;
  tsc: StaticAnalysisToolConfig;
  eslint: StaticAnalysisToolConfig;
  semgrep: StaticAnalysisToolConfig;
}
export interface StaticAnalysisToolResult {
  tool: "tsc" | "eslint" | "semgrep";
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
}
export interface StaticAnalysisGateResult {
  passed: boolean;
  skipped: boolean;
  results: StaticAnalysisToolResult[];
  failureSummary: string | null;
}
