/**
 * Discord Workspace Provisioner
 *
 * Auto-provisions a private Discord category + #general channel for each agent/company
 * in the Autogeny Discord guild, and stores the routing in channel_routings.
 */

import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channelRoutings } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

// Discord channel types
const CHANNEL_TYPE_GUILD_TEXT = 0;
const CHANNEL_TYPE_GUILD_CATEGORY = 4;

// Discord permission bit flags
const PERMISSION_VIEW_CHANNEL = 1n << 10n;
const PERMISSION_SEND_MESSAGES = 1n << 11n;
const PERMISSION_READ_MESSAGE_HISTORY = 1n << 16n;
const BOT_PERMISSIONS = PERMISSION_VIEW_CHANNEL | PERMISSION_SEND_MESSAGES | PERMISSION_READ_MESSAGE_HISTORY;

export interface ProvisionedWorkspace {
  categoryId: string;
  channelId: string;
  channelKey: string;
  webhookUrl: string;
  routingId: string;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

interface DiscordWebhook {
  id: string;
  token: string;
  url?: string;
}

/**
 * Provision a private Discord workspace (category + #general channel + webhook) for an agent.
 *
 * Creates:
 *   - Private category named after the workspace
 *   - #general text channel under that category
 *   - Permission overrides: deny @everyone, allow bot + optionally a Discord user
 *   - An incoming webhook for outbound agent messages
 *   - A channel_routings record linking the channel to the agent
 *
 * @param db - Database connection
 * @param agentId - The agent that will own this workspace
 * @param companyId - The company that owns the agent
 * @param opts - Configuration options
 */
export async function provisionUserWorkspace(
  db: Db,
  agentId: string,
  companyId: string,
  opts: {
    botToken: string;
    guildId: string;
    botClientId: string;
    categoryName?: string;
    discordUserId?: string;
  },
): Promise<ProvisionedWorkspace> {
  const { botToken, guildId, botClientId, discordUserId } = opts;
  const categoryName = opts.categoryName ?? `workspace-${companyId.slice(0, 8)}`;

  logger.info({ agentId, companyId, guildId }, "Provisioning Discord workspace");

  const permissionOverwrites = buildPermissionOverwrites(guildId, botClientId, discordUserId);

  // 1. Create the private category
  const category = await discordRequest<DiscordChannel>(
    botToken,
    "POST",
    `/guilds/${guildId}/channels`,
    {
      name: categoryName,
      type: CHANNEL_TYPE_GUILD_CATEGORY,
      permission_overwrites: permissionOverwrites,
    },
  );
  logger.info({ categoryId: category.id }, "Created Discord category");

  // 2. Create #general text channel under the category
  const channel = await discordRequest<DiscordChannel>(
    botToken,
    "POST",
    `/guilds/${guildId}/channels`,
    {
      name: "general",
      type: CHANNEL_TYPE_GUILD_TEXT,
      parent_id: category.id,
      permission_overwrites: permissionOverwrites,
    },
  );
  logger.info({ channelId: channel.id }, "Created Discord #general channel");

  // 3. Create an incoming webhook for outbound agent messages
  const webhook = await discordRequest<DiscordWebhook>(
    botToken,
    "POST",
    `/channels/${channel.id}/webhooks`,
    { name: `${categoryName}-agent` },
  );
  logger.info({ webhookId: webhook.id }, "Created Discord webhook");

  const channelKey = `${guildId}:${channel.id}`;
  const webhookUrl =
    webhook.url ?? `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;

  // 4. Store routing in channel_routings
  const inserted = await db
    .insert(channelRoutings)
    .values({
      agentId,
      companyId,
      channel: "discord",
      channelKey,
      webhookUrl,
      botToken,
      metadata: {
        categoryId: category.id,
        channelId: channel.id,
        guildId,
        botClientId,
        discordUserId: discordUserId ?? null,
      },
    })
    .returning({ id: channelRoutings.id });

  const routingId = inserted[0]?.id;
  if (!routingId) {
    throw new Error("Failed to insert channel_routing record");
  }

  logger.info({ agentId, companyId, channelKey, routingId }, "Discord workspace provisioned");

  return { categoryId: category.id, channelId: channel.id, channelKey, webhookUrl, routingId };
}

/**
 * Deprovision a Discord workspace for an agent.
 * Optionally deletes the Discord channels via the API.
 */
export async function deprovisionUserWorkspace(
  db: Db,
  agentId: string,
  opts: { botToken?: string; deleteChannels?: boolean } = {},
): Promise<void> {
  const { botToken, deleteChannels = false } = opts;

  if (deleteChannels && botToken) {
    const routings = await db
      .select({ channelKey: channelRoutings.channelKey })
      .from(channelRoutings)
      .where(
        and(eq(channelRoutings.agentId, agentId), eq(channelRoutings.channel, "discord")),
      );

    for (const routing of routings) {
      const channelId = routing.channelKey.split(":")[1];
      if (channelId) {
        await discordRequest(botToken, "DELETE", `/channels/${channelId}`, undefined).catch(
          (err: unknown) => logger.warn({ err, channelId }, "Failed to delete Discord channel"),
        );
      }
    }
  }

  await db
    .delete(channelRoutings)
    .where(
      and(eq(channelRoutings.agentId, agentId), eq(channelRoutings.channel, "discord")),
    );

  logger.info({ agentId }, "Discord workspace deprovisioned");
}

/**
 * Get the provisioned Discord workspace for an agent, if any.
 */
export async function getAgentDiscordWorkspace(
  db: Db,
  agentId: string,
): Promise<ProvisionedWorkspace | null> {
  const rows = await db
    .select({
      id: channelRoutings.id,
      channelKey: channelRoutings.channelKey,
      webhookUrl: channelRoutings.webhookUrl,
      metadata: channelRoutings.metadata,
    })
    .from(channelRoutings)
    .where(
      and(eq(channelRoutings.agentId, agentId), eq(channelRoutings.channel, "discord")),
    )
    .limit(1);

  const routing = rows[0];
  if (!routing) return null;

  const channelId = routing.channelKey.split(":")[1] ?? "";
  const meta = routing.metadata as Record<string, unknown> | null;
  return {
    categoryId: (meta?.["categoryId"] as string | undefined) ?? "",
    channelId,
    channelKey: routing.channelKey,
    webhookUrl: routing.webhookUrl ?? "",
    routingId: routing.id,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPermissionOverwrites(
  guildId: string,
  botClientId: string,
  discordUserId?: string,
): Array<{ id: string; type: number; allow: string; deny: string }> {
  const overwrites: Array<{ id: string; type: number; allow: string; deny: string }> = [
    {
      id: guildId, // @everyone role (id = guildId) — deny view + send
      type: 0,
      allow: "0",
      deny: String(PERMISSION_VIEW_CHANNEL | PERMISSION_SEND_MESSAGES),
    },
    {
      id: botClientId, // Bot — allow all needed permissions
      type: 1,
      allow: String(BOT_PERMISSIONS),
      deny: "0",
    },
  ];

  if (discordUserId) {
    overwrites.push({
      id: discordUserId,
      type: 1,
      allow: String(BOT_PERMISSIONS),
      deny: "0",
    });
  }

  return overwrites;
}

async function discordRequest<T>(
  botToken: string,
  method: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (autogeny-platform, 1.0.0)",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(no body)");
    throw new Error(
      `Discord API error [${method} ${path}]: ${response.status} ${response.statusText} — ${errorText}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
