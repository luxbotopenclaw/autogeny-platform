/**
 * Telegram inbound receiver.
 *
 * Validates incoming webhook Update objects, looks up the agent routing
 * for the chat, and triggers a heartbeat wakeup.
 */
import { timingSafeEqual } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, channelRoutings } from "@paperclipai/db";
import { heartbeatService } from "../heartbeat.js";
import { logger } from "../../middleware/logger.js";

// ─── Telegram API types ───────────────────────────────────────────────────────

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: {
    id: number;
    type: string;
  };
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type TelegramReceiveResult =
  | { status: "routed"; agentId: string; runId: string }
  | { status: "skipped"; reason: string }
  | { status: "no_routing" }
  | { status: "error"; error: string };

// ─── Secret validation ────────────────────────────────────────────────────────

/**
 * Validate a Telegram webhook secret token header using a timing-safe comparison.
 * Returns true if the header matches the configured secret.
 *
 * Telegram allows secrets up to 256 chars composed of [A-Za-z0-9_-].
 */
export function validateTelegramSecret(
  headerValue: string | undefined,
  expectedSecret: string,
): boolean {
  if (!headerValue) return false;
  // timingSafeEqual requires identical byte lengths
  const a = Buffer.from(headerValue, "utf8");
  const b = Buffer.from(expectedSecret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Core receiver ────────────────────────────────────────────────────────────

/**
 * Process a validated Telegram Update object.
 * - Ignores non-text messages
 * - Ignores bot messages (from.is_bot = true)
 * - Looks up agent routing for the chat_id
 * - Wakes the agent via heartbeat wakeup
 */
export async function processTelegramUpdate(
  db: Db,
  update: TelegramUpdate,
): Promise<TelegramReceiveResult> {
  const message = update.message;

  // Ignore non-message updates (edited_message, channel_post, etc.)
  if (!message) {
    return { status: "skipped", reason: "no_message" };
  }

  // Ignore non-text messages (photos, videos, stickers, etc.)
  if (!message.text) {
    return { status: "skipped", reason: "non_text" };
  }

  // Ignore messages from bots
  if (message.from?.is_bot) {
    return { status: "skipped", reason: "bot_message" };
  }

  const chatId = String(message.chat.id);
  const content = message.text;
  const senderId = message.from ? String(message.from.id) : null;
  const senderName = message.from
    ? [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") ||
      message.from.username ||
      null
    : null;

  // Look up routing record for this chatId
  const routing = await db
    .select({
      agentId: channelRoutings.agentId,
      companyId: channelRoutings.companyId,
    })
    .from(channelRoutings)
    .where(
      and(
        eq(channelRoutings.channelKey, chatId),
        eq(channelRoutings.channel, "telegram"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!routing) {
    logger.warn({ chatId }, "telegram: no routing found for chatId");
    return { status: "no_routing" };
  }

  // Verify agent still exists
  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, routing.agentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!agent) {
    logger.warn({ agentId: routing.agentId }, "telegram: routed agentId not found in DB");
    return { status: "no_routing" };
  }

  // Wake the agent via heartbeat
  const heartbeat = heartbeatService(db);
  try {
    const run = await heartbeat.wakeup(routing.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "telegram_message",
      payload: {
        channel: "telegram",
        content,
        senderId,
        senderName,
        chatId,
        metadata: {
          messageId: message.message_id,
          updateId: update.update_id,
          date: message.date,
        },
      },
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    if (!run) {
      return { status: "skipped", reason: "heartbeat_skipped" };
    }

    return { status: "routed", agentId: routing.agentId, runId: run.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, agentId: routing.agentId }, "telegram: heartbeat wakeup failed");
    return { status: "error", error };
  }
}
