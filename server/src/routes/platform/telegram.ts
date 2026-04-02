/**
 * Platform Telegram Routes
 *
 * POST /api/platform/telegram/webhook
 *   Receives Telegram Update objects.
 *   - Validates X-Telegram-Bot-Api-Secret-Token header
 *   - Acknowledges immediately (Telegram requires <5s response)
 *   - Routes messages to agents asynchronously
 *
 * POST /api/platform/telegram/outbound/:agentId
 *   Agents call this to deliver outbound messages to any channel.
 *   - Requires agent or board authentication
 *   - Dispatches to Telegram / Slack / Discord via outbound-router
 */
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import {
  validateTelegramSecret,
  processTelegramUpdate,
  type TelegramUpdate,
} from "../../services/platform/telegram-receiver.js";
import { handleOutboundMessage } from "../../services/platform/outbound-router.js";
import { logger } from "../../middleware/logger.js";

// ─── Validation schema ────────────────────────────────────────────────────────

const outboundBodySchema = z.object({
  channel: z.string().min(1).max(64),
  target: z.string().min(1).max(512),
  content: z.string().min(1).max(65536),
});

// ─── Route factory ────────────────────────────────────────────────────────────

export function telegramPlatformRoutes(db: Db): Router {
  const router = Router();

  // ── POST /webhook ──────────────────────────────────────────────────────────
  router.post("/webhook", async (req: Request, res: Response): Promise<void> => {
    // 1. Validate secret header (fail-closed: treat missing config as mis-configured)
    const webhookSecret = process.env["PLATFORM_TELEGRAM_WEBHOOK_SECRET"];
    if (!webhookSecret) {
      logger.warn("PLATFORM_TELEGRAM_WEBHOOK_SECRET is not configured");
      res.status(503).json({ error: "Webhook not configured" });
      return;
    }

    const headerToken = req.headers["x-telegram-bot-api-secret-token"];
    // Header can be string or string[] — use first value
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!validateTelegramSecret(headerValue, webhookSecret)) {
      // Return 404 per Telegram Bot API security recommendation — don't reveal mismatch
      res.status(404).end();
      return;
    }

    // 2. Validate body shape — Telegram always sends update_id
    const update = req.body as TelegramUpdate;
    if (!update || typeof update.update_id !== "number") {
      res.status(400).json({ error: "Invalid update payload" });
      return;
    }

    // 3. Acknowledge immediately — Telegram times out at 5 seconds
    res.status(200).json({ ok: true });

    // 4. Route asynchronously — errors logged, not propagated
    processTelegramUpdate(db, update).catch((err: unknown) => {
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          updateId: update.update_id,
        },
        "telegram: async routing error",
      );
    });
  });

  return router;
}
