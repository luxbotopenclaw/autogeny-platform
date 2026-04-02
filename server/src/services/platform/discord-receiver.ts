/**
 * Discord Receiver Service
 *
 * Handles inbound Discord interactions/webhooks:
 * - Ed25519 signature validation (X-Signature-Ed25519 + X-Signature-Timestamp)
 * - PING (type=1) → { type: 1 }
 * - APPLICATION_COMMAND (type=2) → route to agent via heartbeat wakeup
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channelRoutings } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

// Discord interaction types
const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const INTERACTION_TYPE_MESSAGE_COMPONENT = 3;
const INTERACTION_TYPE_MODAL_SUBMIT = 5;

// Interaction response types
const RESPONSE_TYPE_PONG = 1;
const RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
const RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE = 5;

export interface DiscordInteractionResponse {
  type: number;
  data?: Record<string, unknown>;
}

export interface HeartbeatWakeupPayload extends Record<string, unknown> {
  channel: "discord";
  content: string;
  senderId: string;
  senderName: string;
  metadata: Record<string, unknown>;
}

/** Minimal heartbeat service interface needed for agent wakeup */
export interface HeartbeatService {
  wakeup: (
    agentId: string,
    opts?: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

/**
 * Validate a Discord Ed25519 webhook signature.
 *
 * Discord signs requests: signature = Ed25519(timestamp + body, privateKey)
 * We verify: Ed25519.verify(signature, timestamp + body, publicKey)
 *
 * @param rawBody - Raw request body (Buffer or string)
 * @param timestamp - X-Signature-Timestamp header value
 * @param signature - X-Signature-Ed25519 header value (hex-encoded)
 * @param publicKey - Discord application's public key (hex-encoded 32 bytes)
 */
export function validateDiscordSignature(
  rawBody: Buffer | string,
  timestamp: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const message = Buffer.concat([
      Buffer.from(timestamp, "utf8"),
      typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody,
    ]);

    // Discord provides a raw 32-byte Ed25519 public key (hex-encoded).
    // Wrap it in DER SPKI format by prepending the ASN.1 OID prefix for Ed25519.
    // Use crypto.verify() (one-shot) — Ed25519 is not hash-then-sign, so
    // createVerify().update().verify() does not work reliably in Node.js.
    const rawKeyBytes = Buffer.from(publicKey, "hex");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer = Buffer.concat([spkiPrefix, rawKeyBytes]);
    const publicKeyObj = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    const signatureBytes = Buffer.from(signature, "hex");

    return cryptoVerify(null, message, publicKeyObj, signatureBytes);
  } catch (err) {
    logger.warn({ err }, "Discord signature validation error");
    return false;
  }
}

/**
 * Look up the agent routing for a given Discord channel.
 *
 * @param db - Database connection
 * @param guildId - Discord guild snowflake ID
 * @param channelId - Discord channel snowflake ID
 */
export async function lookupChannelRouting(
  db: Db,
  guildId: string,
  channelId: string,
): Promise<{ agentId: string; companyId: string } | null> {
  const channelKey = `${guildId}:${channelId}`;

  const rows = await db
    .select({
      agentId: channelRoutings.agentId,
      companyId: channelRoutings.companyId,
    })
    .from(channelRoutings)
    .where(
      and(
        eq(channelRoutings.channel, "discord"),
        eq(channelRoutings.channelKey, channelKey),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Handle a Discord interaction received at the webhook endpoint.
 *
 * Validates the Ed25519 signature, dispatches by interaction type,
 * and triggers heartbeat wakeup for routed messages.
 */
export async function handleDiscordInteraction(
  db: Db,
  rawBody: Buffer,
  headers: {
    "x-signature-ed25519"?: string | undefined;
    "x-signature-timestamp"?: string | undefined;
  },
  heartbeatSvc: HeartbeatService,
  publicKey: string,
): Promise<{ status: number; body: DiscordInteractionResponse | { error: string } }> {
  const signature = headers["x-signature-ed25519"];
  const timestamp = headers["x-signature-timestamp"];

  if (!signature || !timestamp) {
    return { status: 401, body: { error: "Missing signature headers" } };
  }

  // Replay-attack guard: Discord requires the timestamp to be within 5 seconds
  // of the server clock. Without this check a captured valid request can be
  // replayed indefinitely as a heartbeat trigger.
  const nowSec = Math.floor(Date.now() / 1000);
  const tsSec = parseInt(timestamp, 10);
  if (isNaN(tsSec) || Math.abs(nowSec - tsSec) > 5) {
    return { status: 401, body: { error: "Request timestamp out of range" } };
  }

  if (!validateDiscordSignature(rawBody, timestamp, signature, publicKey)) {
    return { status: 401, body: { error: "Invalid request signature" } };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  const interactionType = body["type"] as number;

  // Handle PING — Discord requires immediate response
  if (interactionType === INTERACTION_TYPE_PING) {
    return { status: 200, body: { type: RESPONSE_TYPE_PONG } };
  }

  // Route APPLICATION_COMMAND and MESSAGE_COMPONENT to agent
  if (
    interactionType === INTERACTION_TYPE_APPLICATION_COMMAND ||
    interactionType === INTERACTION_TYPE_MESSAGE_COMPONENT ||
    interactionType === INTERACTION_TYPE_MODAL_SUBMIT
  ) {
    return routeInteractionToAgent(db, body, heartbeatSvc);
  }

  // Unknown type — acknowledge with no-op
  logger.debug({ interactionType }, "Received unknown Discord interaction type");
  return {
    status: 200,
    body: {
      type: RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: "Command received.", flags: 64 },
    },
  };
}

async function routeInteractionToAgent(
  db: Db,
  body: Record<string, unknown>,
  heartbeatSvc: HeartbeatService,
): Promise<{ status: number; body: DiscordInteractionResponse | { error: string } }> {
  const guildId = body["guild_id"] as string | undefined;
  const channelId = body["channel_id"] as string | undefined;

  if (!guildId || !channelId) {
    return {
      status: 200,
      body: {
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: { content: "I can only be used in a server channel.", flags: 64 },
      },
    };
  }

  const routing = await lookupChannelRouting(db, guildId, channelId);
  if (!routing) {
    logger.debug({ guildId, channelId }, "No agent routing found for Discord channel");
    return {
      status: 200,
      body: {
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: { content: "No agent configured for this channel.", flags: 64 },
      },
    };
  }

  const { content, senderId, senderName } = extractInteractionContent(body);

  const wakeupPayload: HeartbeatWakeupPayload = {
    channel: "discord",
    content,
    senderId,
    senderName,
    metadata: {
      guildId,
      channelId,
      interactionId: body["id"] as string | undefined,
      interactionToken: body["token"] as string | undefined,
    },
  };

  try {
    await heartbeatSvc.wakeup(routing.agentId, {
      source: "on_demand",
      triggerDetail: "callback",
      reason: "discord_message",
      payload: wakeupPayload,
      requestedByActorType: "user",
      requestedByActorId: senderId || null,
    });
  } catch (err) {
    logger.error({ err, agentId: routing.agentId }, "Failed to wake agent for Discord interaction");
    return {
      status: 200,
      body: {
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: { content: "Agent temporarily unavailable.", flags: 64 },
      },
    };
  }

  // Return deferred response — agent will follow up via interaction token
  return { status: 200, body: { type: RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE } };
}

function extractInteractionContent(body: Record<string, unknown>): {
  content: string;
  senderId: string;
  senderName: string;
} {
  const data = body["data"] as Record<string, unknown> | undefined;
  const member = body["member"] as Record<string, unknown> | undefined;
  const user =
    (member?.["user"] as Record<string, unknown> | undefined) ??
    (body["user"] as Record<string, unknown> | undefined);

  const senderId = (user?.["id"] as string | undefined) ?? "";
  const username = user?.["username"] as string | undefined;
  const globalName = user?.["global_name"] as string | undefined;
  const senderName = globalName ?? username ?? senderId;

  let content = "";
  if (data) {
    const commandName = data["name"] as string | undefined;
    const options = data["options"] as Array<{ name: string; value: unknown }> | undefined;
    if (commandName) {
      const optStr = options?.map((o) => `${o.name}: ${String(o.value)}`).join(", ");
      content = optStr ? `/${commandName} ${optStr}` : `/${commandName}`;
    }
  }

  return { content, senderId, senderName };
}
