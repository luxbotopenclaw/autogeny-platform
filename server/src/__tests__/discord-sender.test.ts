import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendDiscordMessage, sendDiscordWebhook } from "../services/platform/discord-sender.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("sendDiscordMessage", () => {
  const BOT_TOKEN = "bot-token-12345";
  const CHANNEL_ID = "channel-snowflake-999";
  const CONTENT = "Hello from Autogeny!";

  beforeEach(() => vi.clearAllMocks());

  it("sends a POST to the Discord messages endpoint and returns messageId", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "msg-111", channel_id: CHANNEL_ID }),
    });

    const result = await sendDiscordMessage(BOT_TOKEN, CHANNEL_ID, CONTENT);

    expect(result).toEqual({ messageId: "msg-111", channelId: CHANNEL_ID });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bot ${BOT_TOKEN}`);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string).content).toBe(CONTENT);
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: () => Promise.resolve("Missing Access"),
    });

    await expect(sendDiscordMessage(BOT_TOKEN, CHANNEL_ID, CONTENT)).rejects.toThrow(
      "Discord API error: 403 Forbidden",
    );
  });

  it("includes User-Agent header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "m1", channel_id: CHANNEL_ID }),
    });

    await sendDiscordMessage(BOT_TOKEN, CHANNEL_ID, CONTENT);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("DiscordBot");
  });
});

describe("sendDiscordWebhook", () => {
  const WEBHOOK_URL = "https://discord.com/api/webhooks/123/token";
  const CONTENT = "Agent says hello!";

  beforeEach(() => vi.clearAllMocks());

  it("sends a POST to the webhook URL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

    await sendDiscordWebhook(WEBHOOK_URL, CONTENT);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).content).toBe(CONTENT);
  });

  it("throws on non-2xx response from webhook", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve("Unknown Webhook"),
    });

    await expect(sendDiscordWebhook(WEBHOOK_URL, CONTENT)).rejects.toThrow(
      "Discord webhook error: 404 Not Found",
    );
  });
});
