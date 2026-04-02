/**
 * Shared types for Autogeny platform skills.
 *
 * Platform skills are first-party integrations (SearXNG, STT, G2G, GDP) that
 * run inside the platform server process — as opposed to third-party plugins
 * that run in isolated worker sandboxes.
 *
 * Each platform skill exposes:
 * - `skillId`         — unique identifier, also used as the `company_skills.key`
 * - `toolDefinitions` — JSON-Schema tool declarations (same shape as plugin tools)
 * - `toolHandlers`    — async handler functions keyed by tool name
 * - `installForCompany` — idempotently upserts a `company_skills` row
 */

import type { Db } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// ToolDefinition — mirrors PluginToolDeclaration from @paperclipai/shared
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  /** Tool name, unique within the skill. */
  name: string;
  /** Human-readable display name shown to agents and in the UI. */
  displayName: string;
  /** Description provided to the agent so it knows when to use this tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SkillContext — runtime context passed to each tool handler
// ---------------------------------------------------------------------------

export interface SkillContext {
  /** The database instance, for cross-skill queries (e.g. agent lookup for G2G). */
  db: Db;
  /** The company that the calling agent belongs to. */
  companyId: string | undefined;
  /** The calling agent's ID. */
  agentId: string | undefined;
  /** An OpenClaw gateway bearer token, if available (needed for G2G). */
  gatewayToken: string | undefined;
}

// ---------------------------------------------------------------------------
// PlatformSkill
// ---------------------------------------------------------------------------

export interface PlatformSkill {
  /** Unique skill identifier. Also used as `company_skills.key`. */
  skillId: string;
  /** Tool declarations (for agent discovery and parameter validation). */
  toolDefinitions: ToolDefinition[];
  /**
   * Async handlers keyed by tool name (must match `toolDefinitions[].name`).
   * Each handler receives raw params and a `SkillContext`.
   */
  toolHandlers: Record<
    string,
    (params: unknown, ctx: SkillContext) => Promise<unknown>
  >;
  /**
   * Idempotently install (upsert) this skill for the given company.
   * Writes a `company_skills` row with the skill's markdown documentation.
   */
  installForCompany(db: Db, companyId: string): Promise<void>;
}
