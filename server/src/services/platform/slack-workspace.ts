/**
 * Slack Workspace Provisioner
 *
 * Creates a private Slack channel per user and stores the routing
 * in the channel_routings table so incoming messages can reach the agent.
 *
 * Env vars required:
 *  PLATFORM_SLACK_BOT_TOKEN — Slack bot OAuth token (xoxb-...)
 */

import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channelRoutings, agents, authUsers } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

interface SlackApiResult {
  ok: boolean;
  error?: string;
  channel?: { id: string; name: string };
  [key: string]: unknown;
}

async function slackPost(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<SlackApiResult> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Slack API HTTP ${response.status} for ${method}`);
  }

  return response.json() as Promise<SlackApiResult>;
}

/**
 * Sanitises a username for use as a Slack channel name.
 * Slack channel names must be lowercase, max 80 chars.
 */
export function buildSlackChannelName(username: string): string {
  const sanitized = username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
  return `autogeny-${sanitized || "user"}`;
}

export interface ProvisionResult {
  channelId: string;
  channelName: string;
  routingId: string;
  alreadyExisted: boolean;
}

/**
 * Provisions a private Slack channel for a user and wires it to the agent.
 *
 * Steps:
 *  1. Check if routing already exists (idempotent)
 *  2. Create private channel autogeny-{username} via Slack API
 *  3. Invite the Slack user to the channel
 *  4. Store routing in channel_routings
 */
export async function provisionUserWorkspace(
  db: Db,
  userId: string,
  companyId: string,
  slackUserId: string,
  agentId: string,
): Promise<ProvisionResult> {
  const botToken = process.env["PLATFORM_SLACK_BOT_TOKEN"];
  if (!botToken) {
    throw new Error("PLATFORM_SLACK_BOT_TOKEN is not configured");
  }

  // Verify agent exists in the company
  const agent = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!agent) {
    throw new Error(`Agent ${agentId} not found in company ${companyId}`);
  }

  // Resolve the user's display name for channel naming
  const user = await db
    .select({ name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  const username = user?.name ?? user?.email?.split("@")[0] ?? userId.slice(0, 8);
  const channelName = buildSlackChannelName(username);

  // Check for existing routing (idempotent)
  const existing = await db
    .select()
    .from(channelRoutings)
    .where(
      and(
        eq(channelRoutings.agentId, agentId),
        eq(channelRoutings.channel, "slack"),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (existing) {
    logger.info({ agentId, userId, existingChannelKey: existing.channelKey }, "Slack workspace already provisioned");
    const meta = existing.metadata as Record<string, unknown> | null;
    const existingChannelId = (meta?.["slackChannelId"] as string | undefined) ?? existing.channelKey.split(":")[1] ?? "";
    return {
      channelId: existingChannelId,
      channelName: (meta?.["channelName"] as string | undefined) ?? channelName,
      routingId: existing.id,
      alreadyExisted: true,
    };
  }

  // Create the private channel
  const createResult = await slackPost(botToken, "conversations.create", {
    name: channelName,
    is_private: true,
  });

  if (!createResult.ok || !createResult.channel) {
    if (createResult.error !== "name_taken") {
      throw new Error(`Failed to create Slack channel: ${createResult.error ?? "unknown"}`);
    }
    logger.warn({ channelName }, "Slack channel name already taken — continuing");
  }

  const slackChannelId = createResult.channel?.id;
  if (!slackChannelId) {
    throw new Error("Could not resolve Slack channel ID after provisioning");
  }

  // Invite the user to the channel
  const inviteResult = await slackPost(botToken, "conversations.invite", {
    channel: slackChannelId,
    users: slackUserId,
  });

  if (!inviteResult.ok && inviteResult.error !== "already_in_channel") {
    logger.warn({ slackChannelId, slackUserId, error: inviteResult.error }, "Failed to invite user to Slack channel");
  }

  // Get team ID from auth.test
  const authTestResult = await slackPost(botToken, "auth.test", {});
  const teamId = (authTestResult["team_id"] as string | undefined) ?? "UNKNOWN";
  const channelKey = `${teamId}:${slackChannelId}`;

  // Store routing
  const [inserted] = await db
    .insert(channelRoutings)
    .values({
      agentId,
      companyId,
      channel: "slack",
      channelKey,
      metadata: {
        slackChannelId,
        channelName,
        teamId,
        slackUserId,
        userId,
      },
    })
    .returning({ id: channelRoutings.id });

  if (!inserted) {
    throw new Error("Failed to insert channel_routings record");
  }

  logger.info({ agentId, userId, slackChannelId, channelKey }, "Slack workspace provisioned successfully");

  return {
    channelId: slackChannelId,
    channelName,
    routingId: inserted.id,
    alreadyExisted: false,
  };
}
