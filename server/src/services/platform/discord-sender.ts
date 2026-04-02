/**
 * Discord Outbound Sender
 *
 * Sends messages to Discord channels via:
 * - Discord Webhook URL (preferred for provisioned workspaces)
 * - Discord Bot API (for programmatic channel messages)
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface DiscordSendResult {
  messageId: string;
  channelId: string;
}

/**
 * Send a message to a Discord channel via the Bot API.
 */
export async function sendDiscordMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<DiscordSendResult> {
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (autogeny-platform, 1.0.0)",
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(no body)");
    throw new Error(
      `Discord API error: ${response.status} ${response.statusText} — ${errorText}`,
    );
  }

  const data = (await response.json()) as { id: string; channel_id: string };
  return { messageId: data.id, channelId: data.channel_id };
}

/**
 * Send a message to a Discord channel via an Incoming Webhook URL.
 * Preferred for agent workspace channels.
 */
export async function sendDiscordWebhook(
  webhookUrl: string,
  content: string,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (autogeny-platform, 1.0.0)",
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(no body)");
    throw new Error(
      `Discord webhook error: ${response.status} ${response.statusText} — ${errorText}`,
    );
  }
}
