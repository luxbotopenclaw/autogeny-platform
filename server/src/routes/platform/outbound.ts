/**
 * Platform Outbound Route
 *
 * POST /api/platform/outbound/:agentId
 *   Agents (or board users) call this to deliver messages outbound.
 *   Dispatches to Telegram / Slack / Discord via outbound-router.
 *
 * Authentication:
 *   - Agent callers must provide their own API key (actorMiddleware handles this)
 *   - Agents may only send on behalf of themselves
 *   - Board users may send on behalf of any agent
 */
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { handleOutboundMessage } from "../../services/platform/outbound-router.js";

// ─── Validation schema ────────────────────────────────────────────────────────

const outboundBodySchema = z.object({
  channel: z.string().min(1).max(64),
  target: z.string().min(1).max(512),
  content: z.string().min(1).max(65536),
});

// ─── Route factory ────────────────────────────────────────────────────────────

export function outboundRoutes(db: Db): Router {
  const router = Router();

  router.post("/:agentId", async (req: Request, res: Response): Promise<void> => {
    const agentId = typeof req.params["agentId"] === "string" ? req.params["agentId"] : req.params["agentId"]?.[0];
    if (!agentId) {
      res.status(400).json({ error: "Missing agentId" });
      return;
    }

    // Require authentication: must be the agent itself or a board user
    const actor = req.actor;
    const isAgent = actor.type === "agent";
    const isBoard = actor.type === "board";

    if (!isAgent && !isBoard) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Agents may only send outbound for themselves
    if (isAgent && actor.agentId !== agentId) {
      res.status(403).json({ error: "Forbidden: agent may only send outbound for itself" });
      return;
    }

    // Parse and validate body
    const parseResult = outboundBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid request body", details: parseResult.error.flatten() });
      return;
    }

    const { channel, target, content } = parseResult.data;
    const result = await handleOutboundMessage(db, agentId, { channel, target, content });

    switch (result.status) {
      case "sent":
        res.status(200).json({ ok: true, channel: result.channel });
        return;
      case "no_agent":
        res.status(404).json({ error: "Agent not found" });
        return;
      case "no_routing":
        res.status(404).json({ error: "No channel routing found for agent + channel + target" });
        return;
      case "unsupported_channel":
        res.status(400).json({ error: `Unsupported channel: ${result.channel}` });
        return;
      case "error":
        res.status(502).json({ error: result.error });
        return;
    }
  });

  return router;
}
