/**
 * Discord Webhook + Provision Routes
 *
 * POST /api/platform/discord/webhook
 *   Receives inbound Discord interactions.
 *   Validates Ed25519 signatures, handles PINGs, and routes messages
 *   to the correct agent via heartbeat wakeup.
 *
 *   IMPORTANT: This route must be mounted BEFORE express.json() middleware
 *   because we need raw body bytes for signature validation.
 *
 * POST /api/platform/discord/provision
 *   Provisions a private Discord workspace (category + #general channel + webhook)
 *   for an agent.
 *   Protected by PLATFORM_INTERNAL_SECRET header.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { handleDiscordInteraction } from "../../services/platform/discord-receiver.js";
import { provisionUserWorkspace } from "../../services/platform/discord-workspace.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { logger } from "../../middleware/logger.js";

export function discordWebhookRoutes(db: Db): Router {
  const router = Router();

  // ── POST /webhook ─────────────────────────────────────────────────────────
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

  // ── POST /provision ────────────────────────────────────────────────────────
  router.post("/provision", async (req: Request, res: Response): Promise<void> => {
    // Require internal secret for provisioning calls
    const internalSecret = process.env["PLATFORM_INTERNAL_SECRET"];
    const providedSecret = req.headers["x-platform-internal-secret"];

    if (internalSecret && providedSecret !== internalSecret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Required env vars for Discord provisioning
    const botToken = process.env["PLATFORM_DISCORD_BOT_TOKEN"];
    const guildId = process.env["AUTOGENY_DISCORD_GUILD_ID"];
    const botClientId = process.env["PLATFORM_DISCORD_BOT_ID"];

    if (!botToken || !guildId || !botClientId) {
      const missing = [
        !botToken && "PLATFORM_DISCORD_BOT_TOKEN",
        !guildId && "AUTOGENY_DISCORD_GUILD_ID",
        !botClientId && "PLATFORM_DISCORD_BOT_ID",
      ]
        .filter(Boolean)
        .join(", ");
      logger.error({ missing }, "Discord provisioning env vars not configured");
      res.status(500).json({ error: `Discord provisioning not configured — missing: ${missing}` });
      return;
    }

    const body = req.body as {
      agentId?: string;
      companyId?: string;
      categoryName?: string;
      discordUserId?: string;
    };

    if (!body.agentId || !body.companyId) {
      res.status(400).json({ error: "Missing required fields: agentId, companyId" });
      return;
    }

    try {
      const workspace = await provisionUserWorkspace(db, body.agentId, body.companyId, {
        botToken,
        guildId,
        botClientId,
        categoryName: body.categoryName,
        discordUserId: body.discordUserId,
      });

      res.status(200).json({ ok: true, ...workspace });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err, agentId: body.agentId }, "Failed to provision Discord workspace");
      res.status(500).json({ error: message });
    }
  });

  return router;
}
