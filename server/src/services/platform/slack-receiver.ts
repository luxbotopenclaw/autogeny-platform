/**
 * Slack Receiver Service
 *
 * Handles incoming Slack Events API payloads:
 *  - URL verification challenge
 *  - Signature validation (HMAC-SHA256)
 *  - Message event routing → agent heartbeat wakeup
 *
 * Security:
 *  1. Timestamp replay window: 5 minutes
 *  2. HMAC-SHA256 of "v0:{ts}:{rawBody}" using PLATFORM_SLACK_SIGNING_SECRET
 *  3. Timing-safe comparison
 *  4. Bot messages ignored (bot_id present)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channelRoutings, agents } from "@paperclipai/db";
import { heartbeatService } from "../heartbeat.js";
import { logger } from "../../middleware/logger.js";

const SLACK_TIMESTAMP_TOLERANCE_SECS = 5 * 60;
const SLACK_SIGNING_VERSION = "v0";

export interface SlackMessageEvent {
  type: "message";
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  team?: string;
  bot_id?: string;
  username?: string;
  subtype?: string;
}

export interface SlackEventCallback {
  type: "event_callback";
  team_id: string;
  event: SlackMessageEvent;
  event_id: string;
  event_time: number;
}

export type SlackPayload = { type: string; challenge?: string } | SlackEventCallback;

export interface SlackSignatureResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates the Slack request signature.
 *
 * @param signingSecret - PLATFORM_SLACK_SIGNING_SECRET
 * @param timestamp - X-Slack-Request-Timestamp header value
 * @param rawBody - raw request body as a string
 * @param signature - X-Slack-Signature header value (v0=<hex>)
 */
export function validateSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): SlackSignatureResult {
  if (!signingSecret) {
    return { valid: false, reason: "PLATFORM_SLACK_SIGNING_SECRET not configured" };
  }

  if (!timestamp || !signature) {
    return { valid: false, reason: "Missing signature headers" };
  }

  const requestTime = parseInt(timestamp, 10);
  if (Number.isNaN(requestTime)) {
    return { valid: false, reason: "Invalid timestamp" };
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSecs - requestTime) > SLACK_TIMESTAMP_TOLERANCE_SECS) {
    return { valid: false, reason: "Timestamp too old (replay attack prevention)" };
  }

  const sigBasestring = `${SLACK_SIGNING_VERSION}:${timestamp}:${rawBody}`;
  const expectedHex = createHmac("sha256", signingSecret)
    .update(sigBasestring, "utf8")
    .digest("hex");
  const expected = Buffer.from(`${SLACK_SIGNING_VERSION}=${expectedHex}`, "utf8");
  const provided = Buffer.from(signature, "utf8");

  if (expected.length !== provided.length) {
    return { valid: false, reason: "Signature mismatch" };
  }

  return timingSafeEqual(expected, provided)
    ? { valid: true }
    : { valid: false, reason: "Signature mismatch" };
}

/**
 * Routes an incoming Slack event to the appropriate agent.
 * Fire-and-forget: returns immediately, processes async.
 */
export async function routeSlackEvent(db: Db, payload: SlackEventCallback): Promise<void> {
  const event = payload.event;

  // Ignore bot messages and message subtypes (edits, deletions, etc.)
  if (event.bot_id || event.subtype) {
    logger.debug({ event_id: payload.event_id }, "Ignoring Slack bot/subtype message");
    return;
  }

  const channelKey = `${payload.team_id}:${event.channel}`;

  const routing = await db
    .select({ agentId: channelRoutings.agentId })
    .from(channelRoutings)
    .where(
      and(
        eq(channelRoutings.channel, "slack"),
        eq(channelRoutings.channelKey, channelKey),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (!routing) {
    logger.warn({ channelKey }, "No Slack channel routing found — ignoring event");
    return;
  }

  const agent = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, routing.agentId))
    .then((rows) => rows[0] ?? null);

  if (!agent) {
    logger.error({ agentId: routing.agentId, channelKey }, "Routed agent not found");
    return;
  }

  const hb = heartbeatService(db);

  await hb.wakeup(agent.id, {
    source: "automation",
    triggerDetail: "callback",
    payload: {
      channel: "slack",
      content: event.text ?? "",
      senderId: event.user ?? null,
      senderName: event.username ?? null,
      metadata: {
        teamId: payload.team_id,
        channelId: event.channel,
        channelKey,
        eventId: payload.event_id,
        ts: event.ts,
      },
    },
  });

  logger.info({ agentId: agent.id, channelKey, event_id: payload.event_id }, "Slack message routed to agent");
}
