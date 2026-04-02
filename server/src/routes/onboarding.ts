/**
 * Onboarding Concierge API Routes
 *
 * POST /api/onboarding/start                — create/retrieve active session
 * POST /api/onboarding/:sessionId/message   — send a discovery message
 * GET  /api/onboarding/:sessionId           — fetch session status + recommendation
 * POST /api/onboarding/:sessionId/provision — confirm and provision the team
 */

import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { onboardingConciergeService } from "../services/onboarding/concierge.js";
import { companyPortabilityService } from "../services/index.js";
import type { StorageService } from "../storage/types.js";

export function onboardingRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const concierge = onboardingConciergeService(db);
  const portability = companyPortabilityService(db, storage);

  /** Resolve the acting user ID from the request actor. Throws if not authenticated. */
  function resolveUserId(req: Request): string {
    if (req.actor.type === "none") throw forbidden("Authentication required");
    if (req.actor.type === "board") {
      if (!req.actor.userId) throw forbidden("Authentication required");
      return req.actor.userId;
    }
    if (!req.actor.agentId) throw forbidden("Authentication required");
    return req.actor.agentId;
  }

  // ---------------------------------------------------------------------------
  // POST /start
  // ---------------------------------------------------------------------------

  router.post("/start", async (req, res) => {
    const userId = resolveUserId(req);
    const sessionId = await concierge.startSession(userId);
    res.status(201).json({ sessionId });
  });

  // ---------------------------------------------------------------------------
  // POST /:sessionId/message
  // ---------------------------------------------------------------------------

  router.post("/:sessionId/message", async (req, res) => {
    const userId = resolveUserId(req);
    const { message } = req.body as { message?: unknown };

    if (typeof message !== "string" || !message.trim()) {
      throw badRequest("message must be a non-empty string");
    }
    if (message.length > 10_000) {
      throw badRequest("message must be 10,000 characters or fewer");
    }

    const result = await concierge.processMessage(
      req.params.sessionId!,
      message.trim(),
      userId,
    );

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // GET /:sessionId
  // ---------------------------------------------------------------------------

  router.get("/:sessionId", async (req, res) => {
    const userId = resolveUserId(req);
    const session = await concierge.getSession(req.params.sessionId!, userId);

    if (!session) throw notFound("Onboarding session not found");
    res.json(session);
  });

  // ---------------------------------------------------------------------------
  // POST /:sessionId/provision
  // ---------------------------------------------------------------------------

  router.post("/:sessionId/provision", async (req, res) => {
    const userId = resolveUserId(req);
    const { companyName } = req.body as { companyName?: unknown };

    const companyId = await concierge.provisionTeam(
      req.params.sessionId!,
      userId,
      portability.importBundle.bind(portability),
      typeof companyName === "string" && companyName.trim() ? companyName.trim() : undefined,
    );

    res.status(201).json({ companyId });
  });

  return router;
}
