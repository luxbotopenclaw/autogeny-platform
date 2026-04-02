import { pgTable, uuid, text, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const channelRoutings = pgTable(
  "channel_routings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Messaging channel identifier: "slack" | "discord" | "telegram" */
    channel: text("channel").notNull(),
    /**
     * Channel-specific routing key.
     * For Slack: "{teamId}:{channelId}"
     * For Discord: "{guildId}:{channelId}"
     * For Telegram: "{chatId}"
     */
    channelKey: text("channel_key").notNull(),
    /**
     * Channel bot token (used by Telegram; Discord uses env var; Slack uses env var).
     * Stored here for per-agent token overrides.
     */
    botToken: text("bot_token"),
    /**
     * Outbound webhook URL (used by Discord incoming webhooks for agent→channel messages).
     */
    webhookUrl: text("webhook_url"),
    /**
     * Flexible metadata bag for channel-specific extra data (jsonb).
     * Slack: { slackChannelId, channelName, teamId, slackUserId }
     * Discord: { categoryId, webhookId }
     */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /**
     * Structured channel configuration (jsonb).
     * Added by migration 0049. Used for channel-specific settings.
     */
    config: jsonb("config").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentChannelKeyUniqueIdx: unique("channel_routings_agent_channel_key_uniq").on(
      table.agentId,
      table.channel,
      table.channelKey,
    ),
    channelKeyIdx: index("channel_routings_channel_key_idx").on(table.channel, table.channelKey),
    companyIdx: index("channel_routings_company_idx").on(table.companyId),
  }),
);
