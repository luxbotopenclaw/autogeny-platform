/**
 * Platform Slack Routes
 *
 * POST /api/platform/slack/webhook
 *   Receives Slack Events API payloads.
 *   - Validates X-Slack-Signature HMAC-SHA256
 *   - Handles url_verification challenge
 *   - Routes message events to agents via heartbeat wakeup
 *   - Acknowledges within 200ms (responds immediately, processes async)
 *
 * POST /api/platform/slack/provision
 *   Provisions a private Slack channel for a user.
 *   Protected by PLATFORM_INTERNAL_SECRET header.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  validateSlackSignature,
  routeSlackEvent,
  type SlackEventCallback,
} from "../../services/platform/slack-receiver.js";
import { provisionUserWorkspace } from "../../services/platform/slack-workspace.js";
import { logger } from "../../middleware/logger.js";

export function slackPlatformRoutes(db: Db): Router {
  const router = Router();

  // ── POST /webhook ─────────────────────────────────────────────────────────
  router.post("/webhook", (req: Request, res: Response) => {
    const signingSecret = process.env["PLATFORM_SLACK_SIGNING_SECRET"] ?? "";
    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;

    // rawBody is stored by the express.json verify callback in app.ts
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "";

    // Validate signature (only if secret is configured)
    if (signingSecret) {
      const result = validateSlackSignature(
        signingSecret,
        timestamp ?? "",
        rawBody,
        signature ?? "",
      );
      if (!result.valid) {
        logger.warn({ reason: result.reason }, "Slack signature validation failed");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }

    const payload = req.body as { type?: string; challenge?: string; team_id?: string; event?: unknown; event_id?: string; event_time?: number };

    if (!payload || typeof payload.type !== "string") {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }

    // URL Verification Challenge
    if (payload.type === "url_verification") {
      res.status(200).json({ challenge: payload.challenge });
      return;
    }

    // Event Callback — acknowledge immediately, process async
    if (payload.type === "event_callback") {
      res.status(200).json({ ok: true });

      setImmediate(() => {
        routeSlackEvent(db, payload as SlackEventCallback).catch((err: unknown) => {
          logger.error({ err, event_id: (payload as SlackEventCallback).event_id }, "Failed to route Slack event");
        });
      });

      return;
    }

    // Unknown event type — ack to prevent Slack retries
    res.status(200).json({ ok: true });
  });

  // ── POST /provision ──────────────────────────────────────────────────────
  router.post("/provision", async (req: Request, res: Response) => {
    const internalSecret = process.env["PLATFORM_INTERNAL_SECRET"];
    const providedSecret = req.headers["x-platform-internal-secret"];

    if (internalSecret && providedSecret !== internalSecret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { userId, companyId, slackUserId, agentId } = req.body as {
      userId?: string;
      companyId?: string;
      slackUserId?: string;
      agentId?: string;
    };

    if (!userId || !companyId || !slackUserId || !agentId) {
      res.status(400).json({ error: "Missing required fields: userId, companyId, slackUserId, agentId" });
      return;
    }

    try {
      const result = await provisionUserWorkspace(db, userId, companyId, slackUserId, agentId);
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err, userId, agentId }, "Failed to provision Slack workspace");
      res.status(500).json({ error: message });
    }
  });

  return router;
}
