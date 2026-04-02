/**
 * Outbound Router
 *
 * Routes outbound messages from agents to the correct channel sender
 * (Telegram, Slack, Discord).
 */
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, channelRoutings } from "@paperclipai/db";
import { sendTelegramMessage } from "./telegram-sender.js";
import { sendSlackMessage } from "./slack-sender.js";
import { sendDiscordMessage, sendDiscordWebhook } from "./discord-sender.js";
import { logger } from "../../middleware/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Global content length cap across all channels */
const MAX_CONTENT_LENGTH = 4096;

/** Discord-specific content length limit */
const DISCORD_MAX_CONTENT = 2000;

/** Required URL prefix for Discord webhooks (SSRF prevention) */
const DISCORD_WEBHOOK_HOST = "https://discord.com/";

// ─── Result types ─────────────────────────────────────────────────────────────

export type OutboundResult =
  | { status: "sent"; channel: string }
  | { status: "no_agent" }
  | { status: "no_routing" }
  | { status: "unsupported_channel"; channel: string }
  | { status: "error"; error: string };

// ─── Supported channels ───────────────────────────────────────────────────────

const SUPPORTED_CHANNELS = new Set(["telegram", "slack", "discord"]);

// ─── Core router ─────────────────────────────────────────────────────────────

/**
 * Handle an outbound message request.
 * - Verifies agent exists in DB
 * - Validates channel is supported
 * - Looks up routing record for (agentId, channel, target)
 * - Routes to the correct sender
 * - Updates agent lastHeartbeatAt on success
 */
export async function handleOutboundMessage(
  db: Db,
  agentId: string,
  opts: { channel: string; target: string; content: string },
): Promise<OutboundResult> {
  const { channel, target, content } = opts;

  // 1. Verify agent exists
  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!agent) {
    return { status: "no_agent" };
  }

  // 2. Validate channel is supported
  if (!SUPPORTED_CHANNELS.has(channel)) {
    return { status: "unsupported_channel", channel };
  }

  // 3. Look up routing record for (agentId, channel, target)
  const routing = await db
    .select({
      botToken: channelRoutings.botToken,
      webhookUrl: channelRoutings.webhookUrl,
      channelKey: channelRoutings.channelKey,
      config: channelRoutings.config,
    })
    .from(channelRoutings)
    .where(
      and(
        eq(channelRoutings.agentId, agentId),
        eq(channelRoutings.channel, channel),
        eq(channelRoutings.channelKey, target),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!routing) {
    return { status: "no_routing" };
  }

  // 4. Global content length cap
  if (content.length > MAX_CONTENT_LENGTH) {
    return {
      status: "error",
      error: `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
    };
  }

  // 5. Route to the correct sender
  try {
    if (channel === "telegram") {
      if (!routing.botToken) {
        return { status: "error", error: "Telegram routing is missing botToken" };
      }
      await sendTelegramMessage(routing.botToken, target, content);
    } else if (channel === "slack") {
      if (!routing.botToken) {
        return { status: "error", error: "Slack routing is missing botToken" };
      }
      await sendSlackMessage(routing.botToken, target, content);
    } else if (channel === "discord") {
      // Discord-specific content cap (stricter than global)
      if (content.length > DISCORD_MAX_CONTENT) {
        return {
          status: "error",
          error: `Discord content exceeds maximum length of ${DISCORD_MAX_CONTENT} characters`,
        };
      }
      if (routing.webhookUrl) {
        // SSRF prevention: only allow webhook URLs on discord.com
        if (!routing.webhookUrl.startsWith(DISCORD_WEBHOOK_HOST)) {
          return {
            status: "error",
            error: `Discord webhook URL must start with ${DISCORD_WEBHOOK_HOST}`,
          };
        }
        await sendDiscordWebhook(routing.webhookUrl, content);
      } else if (routing.botToken) {
        await sendDiscordMessage(routing.botToken, target, content);
      } else {
        return { status: "error", error: "Discord routing is missing botToken or webhookUrl" };
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ agentId, channel, target, error }, "outbound: send failed");
    return { status: "error", error };
  }

  // 6. Update agent lastHeartbeatAt — separated from send error handling so that a
  //    transient DB failure here does not mask a successfully-delivered message.
  try {
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(agents.id, agentId));
  } catch (heartbeatErr) {
    logger.warn(
      { agentId, error: heartbeatErr instanceof Error ? heartbeatErr.message : String(heartbeatErr) },
      "outbound: heartbeat update failed (message was sent)",
    );
  }

  logger.info({ agentId, channel, target }, "outbound: message sent successfully");
  return { status: "sent", channel };
}
