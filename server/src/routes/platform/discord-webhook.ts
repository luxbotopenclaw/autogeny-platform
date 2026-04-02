/**
 * Discord Webhook Route
 *
 * POST /api/platform/discord/webhook
 *
 * Receives inbound Discord interactions.
 * Validates Ed25519 signatures, handles PINGs, and routes messages
 * to the correct agent via heartbeat wakeup.
 *
 * IMPORTANT: This route must be mounted BEFORE express.json() middleware
 * because we need raw body bytes for signature validation.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { handleDiscordInteraction } from "../../services/platform/discord-receiver.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { logger } from "../../middleware/logger.js";

export function discordWebhookRoutes(db: Db): Router {
  const router = Router();

  router.post(
    "/webhook",
    // Raw body capture middleware — MUST run before JSON parsing
    (req: Request, res: Response, next) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        (req as Request & { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
        next();
      });
      req.on("error", (err) => {
        logger.error({ err }, "Error reading Discord webhook body");
        res.status(400).json({ error: "Failed to read request body" });
      });
    },
    async (req: Request, res: Response): Promise<void> => {
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

      if (!rawBody || rawBody.length === 0) {
        res.status(400).json({ error: "Empty request body" });
        return;
      }

      const publicKey = process.env["PLATFORM_DISCORD_PUBLIC_KEY"];
      if (!publicKey) {
        logger.error("PLATFORM_DISCORD_PUBLIC_KEY not configured");
        res.status(500).json({ error: "Discord integration not configured" });
        return;
      }

      const heartbeat = heartbeatService(db);

      const result = await handleDiscordInteraction(
        db,
        rawBody,
        {
          "x-signature-ed25519": req.headers["x-signature-ed25519"] as string | undefined,
          "x-signature-timestamp": req.headers["x-signature-timestamp"] as string | undefined,
        },
        heartbeat,
        publicKey,
      );

      res.status(result.status).json(result.body);
    },
  );

  return router;
}
