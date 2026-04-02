/**
 * Platform Skills API routes
 *
 * GET  /api/platform/skills
 *   List all available platform skills (instance admin only).
 *
 * POST /api/platform/skills/:skillId/install
 *   Install a platform skill for a company (instance admin only).
 *   Body: { companyId: string }
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { platformSkillRegistry } from "../services/platform-skills/index.js";
import { assertInstanceAdmin } from "./authz.js";

export function platformSkillRoutes(db: Db): Router {
  const router = Router();

  // ── GET /platform/skills ──────────────────────────────────────────────────
  router.get("/platform/skills", (req: Request, res: Response): void => {
    assertInstanceAdmin(req);
    const skills = platformSkillRegistry.listSkills().map((s) => ({
      skillId: s.skillId,
      toolCount: s.toolDefinitions.length,
      tools: s.toolDefinitions.map((t) => ({
        name: t.name,
        displayName: t.displayName,
        description: t.description,
      })),
    }));
    res.json({ skills });
  });

  // ── POST /platform/skills/:skillId/install ────────────────────────────────
  router.post(
    "/platform/skills/:skillId/install",
    async (req: Request, res: Response): Promise<void> => {
      assertInstanceAdmin(req);

      // Express v5: params values are string | string[] — extract the string
      const rawSkillId = req.params["skillId"];
      const skillId = Array.isArray(rawSkillId) ? rawSkillId[0] : rawSkillId;

      if (!skillId) {
        res.status(400).json({ error: "skillId path parameter is required" });
        return;
      }

      const body = req.body as { companyId?: unknown };
      if (!body.companyId || typeof body.companyId !== "string" || body.companyId.trim() === "") {
        res.status(400).json({ error: "companyId is required in request body" });
        return;
      }

      const companyId = body.companyId.trim();

      const skill = platformSkillRegistry.getSkill(skillId);
      if (!skill) {
        const available = platformSkillRegistry
          .listSkills()
          .map((s) => s.skillId)
          .join(", ");
        res.status(404).json({
          error: `Platform skill '${skillId}' not found`,
          available,
        });
        return;
      }

      await platformSkillRegistry.installSkill(db, companyId, skillId);

      res.status(200).json({
        installed: true,
        skillId,
        companyId,
      });
    },
  );

  return router;
}
