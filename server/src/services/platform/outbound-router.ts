/**
 * Unified outbound message router.
 *
 * Agents call POST /api/platform/outbound/:agentId with a channel + target +
 * content, and this router delivers via the appropriate sender
 * (Telegram, Slack, Discord) based on the stored channel_routing record.
 *
 * Channel-specific credential sources:
 *   - telegram : botToken stored in the routing record
 *   - slack    : botToken stored in the routing record
 *   - discord  : webhookUrl (with SSRF guard) stored in the routing record;
 *                fallback to PLATFORM_DISCORD_BOT_TOKEN env var + config.channelId
 */
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, channelRoutings } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { sendTelegramMessage } from "./telegram-sender.js";
import { sendSlackMessage } from "./slack-sender.js";
import { sendDiscordMessage } from "./discord-sender.js";

const DISCORD_MAX_CONTENT = 2000;

// ─── SSRF guard: allowed Discord webhook hostnames ────────────────────────────
const DISCORD_ALLOWED_HOSTNAMES = new Set(["discord.com", "discordapp.com"]);

function validateDiscordWebhookUrl(url: string): { valid: true; parsed: URL } | { valid: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "invalid webhookUrl format" };
  }
  if (!DISCORD_ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    return { valid: false, error: `webhookUrl must point to discord.com (got: ${parsed.hostname})` };
  }
  if (parsed.protocol !== "https:") {
    return { valid: false, error: "webhookUrl must use HTTPS" };
  }
  return { valid: true, parsed };
}

// ─── Request / Result types ───────────────────────────────────────────────────

export interface OutboundMessageRequest {
  /** Target channel: "telegram" | "slack" | "discord" */
  channel: string;
  /** Channel-specific target identifier (chatId, Slack channelId, Discord channelKey) */
  target: string;
  /** Text content to deliver */
  content: string;
}

export type OutboundResult =
  | { status: "sent"; channel: string }
  | { status: "no_agent" }
  | { status: "no_routing" }
  | { status: "unsupported_channel"; channel: string }
  | { status: "error"; error: string };

// ─── Supported channels ───────────────────────────────────────────────────────

const SUPPORTED_CHANNELS = new Set(["telegram", "slack", "discord"]);

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Route an outbound message from an agent to the correct channel.
 *
 * Validates:
 * 1. Channel is one of: telegram, slack, discord
 * 2. Agent exists
 * 3. A channel_routings record exists for (agentId, channel, target)
 * 4. The record has required credentials
 *
 * Side effect: updates agent.lastHeartbeatAt to signal liveness.
 */
export async function handleOutboundMessage(
  db: Db,
  agentId: string,
  req: OutboundMessageRequest,
): Promise<OutboundResult> {
  const { channel, target, content } = req;

  // 0. Validate channel type
  if (!SUPPORTED_CHANNELS.has(channel)) {
    return { status: "unsupported_channel", channel };
  }

  // 1. Verify agent exists
  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!agent) {
    logger.warn({ agentId }, "outbound-router: agent not found");
    return { status: "no_agent" };
  }

  // 2. Look up routing record
  const routing = await db
    .select({
      botToken: channelRoutings.botToken,
      webhookUrl: channelRoutings.webhookUrl,
      channelKey: channelRoutings.channelKey,
      metadata: channelRoutings.metadata,
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
    logger.warn({ agentId, channel, target }, "outbound-router: no routing record found");
    return { status: "no_routing" };
  }

  // 3. Deliver via the correct sender
  try {
    if (channel === "telegram") {
      if (!routing.botToken) {
        return { status: "error", error: "telegram routing is missing botToken" };
      }
      await sendTelegramMessage(routing.botToken, target, content);

    } else if (channel === "slack") {
      if (!routing.botToken) {
        return { status: "error", error: "slack routing is missing botToken" };
      }
      await sendSlackMessage(routing.botToken, target, content);

    } else if (channel === "discord") {
      if (content.length > DISCORD_MAX_CONTENT) {
        return {
          status: "error",
          error: `discord content exceeds ${DISCORD_MAX_CONTENT} character limit`,
        };
      }
      if (routing.webhookUrl) {
        // SSRF guard: only permit legitimate Discord webhook URLs
        const check = validateDiscordWebhookUrl(routing.webhookUrl);
        if (!check.valid) {
          return { status: "error", error: `discord routing: ${check.error}` };
        }
        await sendDiscordWebhook(routing.webhookUrl, content);
      } else {
        // Fallback: use platform bot token + channelId from config
        const discordBotToken = process.env["PLATFORM_DISCORD_BOT_TOKEN"];
        if (!discordBotToken) {
          return {
            status: "error",
            error: "PLATFORM_DISCORD_BOT_TOKEN is not configured and no webhookUrl stored",
          };
        }
        const metadata = routing.metadata as Record<string, unknown> | null | undefined;
        const channelId = (metadata?.["channelId"] as string | undefined) ?? null;
        if (!channelId) {
          return { status: "error", error: "discord routing config is missing channelId" };
        }
        await sendDiscordMessage(discordBotToken, channelId, content);
      }
    } else {
      // Unreachable due to SUPPORTED_CHANNELS guard
      return { status: "unsupported_channel", channel };
    }

    // 4. Update agent.lastHeartbeatAt to signal liveness
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    return { status: "sent", channel };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, agentId, channel, target }, "outbound-router: send failed");
    return { status: "error", error };
  }
}

// ─── Inline webhook helper (avoids adding yet another sender module) ──────────

async function sendDiscordWebhook(webhookUrl: string, content: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Discord webhook network error: ${message}`);
  }
  // Discord returns 204 No Content on success
  if (res.status === 204 || res.ok) return;
  const body = await res.text().catch(() => "");
  throw new Error(`Discord webhook error ${res.status}: ${body}`);
}
