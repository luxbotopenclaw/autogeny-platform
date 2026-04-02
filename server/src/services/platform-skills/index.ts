/**
 * Platform Skills Registry
 *
 * Registers all first-party Autogeny platform skills and exposes a single
 * `platformSkillRegistry` for listing skills, executing tool calls, and
 * installing skills per company.
 */

import type { Db } from "@paperclipai/db";
import type { PlatformSkill, SkillContext } from "./types.js";
import { autogenySearchSkill } from "./autogeny-search.js";
import { autogenySttSkill } from "./autogeny-stt.js";
import { autogenyG2GSkill } from "./autogeny-g2g.js";
import { autogenyGdpSkill } from "./autogeny-gdp.js";

export type { PlatformSkill, SkillContext, ToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const SKILLS: PlatformSkill[] = [
  autogenySearchSkill,
  autogenySttSkill,
  autogenyG2GSkill,
  autogenyGdpSkill,
];

const SKILL_MAP = new Map<string, PlatformSkill>(SKILLS.map((s) => [s.skillId, s]));

export interface PlatformSkillRegistry {
  listSkills(): PlatformSkill[];
  getSkill(skillId: string): PlatformSkill | undefined;
  installSkill(db: Db, companyId: string, skillId: string): Promise<void>;
  executeTool(
    skillId: string,
    toolName: string,
    params: unknown,
    ctx: SkillContext,
  ): Promise<unknown>;
}

function createPlatformSkillRegistry(): PlatformSkillRegistry {
  function listSkills(): PlatformSkill[] {
    return [...SKILLS];
  }

  function getSkill(skillId: string): PlatformSkill | undefined {
    return SKILL_MAP.get(skillId);
  }

  async function installSkill(db: Db, companyId: string, skillId: string): Promise<void> {
    const skill = SKILL_MAP.get(skillId);
    if (!skill) {
      throw new Error(
        `Platform skill '${skillId}' not found. ` +
          `Available skills: ${[...SKILL_MAP.keys()].join(", ")}`,
      );
    }
    await skill.installForCompany(db, companyId);
  }

  async function executeTool(
    skillId: string,
    toolName: string,
    params: unknown,
    ctx: SkillContext,
  ): Promise<unknown> {
    const skill = SKILL_MAP.get(skillId);
    if (!skill) {
      throw new Error(`Platform skill '${skillId}' not found`);
    }
    const handler = skill.toolHandlers[toolName];
    if (!handler) {
      const available = Object.keys(skill.toolHandlers).join(", ");
      throw new Error(
        `Tool '${toolName}' not found in skill '${skillId}'. ` +
          `Available tools: ${available}`,
      );
    }
    return handler(params, ctx);
  }

  return { listSkills, getSkill, installSkill, executeTool };
}

export const platformSkillRegistry = createPlatformSkillRegistry();

// ---------------------------------------------------------------------------
// Re-export individual skill modules for targeted imports
// ---------------------------------------------------------------------------

export { autogenySearchSkill } from "./autogeny-search.js";
export { autogenySttSkill } from "./autogeny-stt.js";
export { autogenyG2GSkill } from "./autogeny-g2g.js";
export { autogenyGdpSkill } from "./autogeny-gdp.js";
