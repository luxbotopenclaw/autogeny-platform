/**
 * Slack Outbound Sender
 *
 * Thin wrapper around the Slack Web API chat.postMessage endpoint.
 */

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

/**
 * Posts a message to a Slack channel via the Web API.
 */
export async function sendSlackMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<SlackApiResponse> {
  const body = JSON.stringify({
    channel: channelId,
    text: content,
  });

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Slack API HTTP error: ${response.status} ${response.statusText}`);
  }

  // Slack Web API returns HTTP 200 even for application-level errors — must check `ok`.
  const data = (await response.json()) as SlackApiResponse;
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error ?? "unknown_error"}`);
  }
  return data;
}
