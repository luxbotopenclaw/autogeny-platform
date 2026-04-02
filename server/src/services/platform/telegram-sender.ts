/**
 * Telegram Outbound Sender
 *
 * Sends messages via the Telegram Bot API sendMessage method.
 */

export interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
}

/**
 * Sends a text message to a Telegram chat.
 *
 * @param botToken - Telegram Bot API token
 * @param chatId - Telegram chat ID (numeric string or username)
 * @param text - Message text
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<TelegramApiResponse> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!response.ok) {
    throw new Error(`Telegram API HTTP error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<TelegramApiResponse>;
}
