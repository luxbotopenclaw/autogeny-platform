/**
 * Tests for Task 8: Telegram Receiver + Outbound Router
 *
 * Covers:
 * - validateTelegramSecret
 * - processTelegramUpdate routing logic
 * - handleOutboundMessage routing logic
 * - HTTP routes: POST /telegram/webhook, POST /platform/outbound/:agentId
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

// ─── Mock heartbeat service ───────────────────────────────────────────────────

const mockHeartbeatWakeup = vi.fn();
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup: mockHeartbeatWakeup,
  }),
}));

// ─── Mock senders ─────────────────────────────────────────────────────────────

const mockSendTelegram = vi.fn();
const mockSendSlack = vi.fn();
const mockSendDiscord = vi.fn();

vi.mock("../services/platform/telegram-sender.js", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegram(...args),
}));
vi.mock("../services/platform/slack-sender.js", () => ({
  sendSlackMessage: (...args: unknown[]) => mockSendSlack(...args),
}));
vi.mock("../services/platform/discord-sender.js", () => ({
  sendDiscordMessage: (...args: unknown[]) => mockSendDiscord(...args),
}));

// ─── Import units under test ──────────────────────────────────────────────────

import {
  validateTelegramSecret,
  processTelegramUpdate,
  type TelegramUpdate,
} from "../services/platform/telegram-receiver.js";
import { handleOutboundMessage } from "../services/platform/outbound-router.js";
import { telegramPlatformRoutes } from "../routes/platform/telegram.js";
import { outboundRoutes } from "../routes/platform/outbound.js";

// ─── DB mock helpers ──────────────────────────────────────────────────────────

/** Build a minimal mock DB that returns `routingRow` for first select, `agentRow` for second. */
function buildInboundMockDb({
  routingRow = null as { agentId: string; companyId: string } | null,
  agentRow = null as { id: string; companyId: string } | null,
} = {}) {
  let callIdx = 0;
  const makeChain = (row: unknown[] | []) => ({
    from: () => makeChain(row),
    where: () => makeChain(row),
    limit: () => ({ then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn(row)) }),
  });

  return {
    select: vi.fn().mockImplementation(() => {
      const idx = callIdx++;
      const rows = idx === 0 ? (routingRow ? [routingRow] : []) : agentRow ? [agentRow] : [];
      return makeChain(rows as unknown[]);
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
  } as unknown as import("@paperclipai/db").Db;
}

// ─── validateTelegramSecret ───────────────────────────────────────────────────

describe("validateTelegramSecret", () => {
  it("returns true when header matches secret", () => {
    expect(validateTelegramSecret("mysecret", "mysecret")).toBe(true);
  });

  it("returns false when header is missing", () => {
    expect(validateTelegramSecret(undefined, "mysecret")).toBe(false);
  });

  it("returns false when header differs", () => {
    expect(validateTelegramSecret("wrong", "mysecret")).toBe(false);
  });

  it("returns false for different-length values (prevents length oracle)", () => {
    expect(validateTelegramSecret("short", "muchlonger")).toBe(false);
  });
});

// ─── processTelegramUpdate ────────────────────────────────────────────────────

describe("processTelegramUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseUpdate: TelegramUpdate = {
    update_id: 100,
    message: {
      message_id: 1,
      from: { id: 42, is_bot: false, first_name: "Alice" },
      chat: { id: 9999, type: "private" },
      date: 1700000000,
      text: "Hello agent",
    },
  };

  it("skips updates with no message", async () => {
    const result = await processTelegramUpdate(buildInboundMockDb(), { update_id: 1 });
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).toBe("no_message");
  });

  it("skips non-text messages", async () => {
    const update: TelegramUpdate = {
      ...baseUpdate,
      message: { ...baseUpdate.message!, text: undefined },
    };
    const result = await processTelegramUpdate(buildInboundMockDb(), update);
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).toBe("non_text");
  });

  it("skips bot messages", async () => {
    const update: TelegramUpdate = {
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        from: { id: 99, is_bot: true, first_name: "Bot" },
      },
    };
    const result = await processTelegramUpdate(buildInboundMockDb(), update);
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).toBe("bot_message");
  });

  it("returns no_routing when chatId is not in channel_routings", async () => {
    const db = buildInboundMockDb({ routingRow: null });
    const result = await processTelegramUpdate(db, baseUpdate);
    expect(result.status).toBe("no_routing");
  });

  it("routes to agent when routing found and wakeup succeeds", async () => {
    mockHeartbeatWakeup.mockResolvedValue({ id: "run-abc", status: "queued" });

    const db = buildInboundMockDb({
      routingRow: { agentId: "agent-1", companyId: "company-1" },
      agentRow: { id: "agent-1", companyId: "company-1" },
    });

    const result = await processTelegramUpdate(db, baseUpdate);
    expect(result.status).toBe("routed");
    expect((result as { agentId: string }).agentId).toBe("agent-1");

    expect(mockHeartbeatWakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        payload: expect.objectContaining({
          channel: "telegram",
          content: "Hello agent",
          senderId: "42",
          senderName: "Alice",
        }),
      }),
    );
  });

  it("returns skipped when heartbeat.wakeup returns null", async () => {
    mockHeartbeatWakeup.mockResolvedValue(null);
    const db = buildInboundMockDb({
      routingRow: { agentId: "agent-1", companyId: "company-1" },
      agentRow: { id: "agent-1", companyId: "company-1" },
    });
    const result = await processTelegramUpdate(db, baseUpdate);
    expect(result.status).toBe("skipped");
  });
});

// ─── handleOutboundMessage ────────────────────────────────────────────────────

describe("handleOutboundMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Build a mock DB that returns agentRow on first select, routingRow on second */
  function buildOutboundDb(
    agentRow: { id: string; companyId: string } | null,
    routingRow: {
      botToken?: string | null;
      webhookUrl?: string | null;
      channelKey?: string;
      config?: Record<string, unknown> | null;
    } | null,
  ) {
    let callIdx = 0;
    const makeChain = (rows: unknown[]) => ({
      from: () => makeChain(rows),
      where: () => makeChain(rows),
      limit: () => ({
        then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn(rows)),
      }),
    });
    return {
      select: vi.fn().mockImplementation(() => {
        const idx = callIdx++;
        return makeChain(
          idx === 0
            ? agentRow ? [agentRow] : []
            : routingRow ? [routingRow] : [],
        );
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    } as unknown as import("@paperclipai/db").Db;
  }

  it("returns no_agent when agent does not exist", async () => {
    const db = buildOutboundDb(null, null);
    const result = await handleOutboundMessage(db, "ghost", {
      channel: "telegram",
      target: "12345",
      content: "hi",
    });
    expect(result.status).toBe("no_agent");
  });

  it("returns unsupported_channel for unknown channels", async () => {
    const db = buildOutboundDb({ id: "a1", companyId: "c1" }, null);
    const result = await handleOutboundMessage(db, "a1", {
      channel: "whatsapp",
      target: "+1",
      content: "hi",
    });
    expect(result.status).toBe("unsupported_channel");
  });

  it("returns no_routing when no routing record found", async () => {
    const db = buildOutboundDb({ id: "a1", companyId: "c1" }, null);
    const result = await handleOutboundMessage(db, "a1", {
      channel: "telegram",
      target: "99",
      content: "hi",
    });
    expect(result.status).toBe("no_routing");
  });

  it("sends via Telegram when routing found with botToken", async () => {
    mockSendTelegram.mockResolvedValue({ ok: true, messageId: 5 });
    const db = buildOutboundDb(
      { id: "a1", companyId: "c1" },
      { botToken: "tok123", webhookUrl: null, channelKey: "42", config: null },
    );
    const result = await handleOutboundMessage(db, "a1", {
      channel: "telegram",
      target: "42",
      content: "Hello!",
    });
    expect(result.status).toBe("sent");
    expect(mockSendTelegram).toHaveBeenCalledWith("tok123", "42", "Hello!");
  });

  it("sends via Slack when routing found with botToken", async () => {
    mockSendSlack.mockResolvedValue({ ok: true, ts: "1234.5678" });
    const db = buildOutboundDb(
      { id: "a1", companyId: "c1" },
      { botToken: "xoxb-test", webhookUrl: null, channelKey: "C123", config: null },
    );
    const result = await handleOutboundMessage(db, "a1", {
      channel: "slack",
      target: "C123",
      content: "Slack message",
    });
    expect(result.status).toBe("sent");
    expect(mockSendSlack).toHaveBeenCalledWith("xoxb-test", "C123", "Slack message");
  });

  it("returns error for discord content exceeding 2000 chars", async () => {
    const db = buildOutboundDb(
      { id: "a1", companyId: "c1" },
      { botToken: null, webhookUrl: "https://discord.com/api/webhooks/x/y", channelKey: "ch", config: null },
    );
    const result = await handleOutboundMessage(db, "a1", {
      channel: "discord",
      target: "ch",
      content: "x".repeat(2001),
    });
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toMatch(/2000/);
  });

  it("returns error for discord with SSRF-suspicious webhookUrl", async () => {
    const db = buildOutboundDb(
      { id: "a1", companyId: "c1" },
      {
        botToken: null,
        webhookUrl: "https://internal.company.local/hook",
        channelKey: "ch",
        config: null,
      },
    );
    const result = await handleOutboundMessage(db, "a1", {
      channel: "discord",
      target: "ch",
      content: "hi",
    });
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toMatch(/discord\.com/);
  });
});

// ─── HTTP routes ──────────────────────────────────────────────────────────────

function buildTelegramApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/platform/telegram", telegramPlatformRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildOutboundApp(
  actorOverride: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["c1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorOverride;
    next();
  });
  app.use("/api/platform/outbound", outboundRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/platform/telegram/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatWakeup.mockResolvedValue({ id: "run-1", status: "queued" });
  });

  it("returns 503 when PLATFORM_TELEGRAM_WEBHOOK_SECRET is not set", async () => {
    delete process.env["PLATFORM_TELEGRAM_WEBHOOK_SECRET"];
    const res = await request(buildTelegramApp())
      .post("/api/platform/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "any")
      .send({ update_id: 1 });
    expect(res.status).toBe(503);
  });

  it("returns 404 when secret header is missing", async () => {
    process.env["PLATFORM_TELEGRAM_WEBHOOK_SECRET"] = "correctsecret";
    const res = await request(buildTelegramApp())
      .post("/api/platform/telegram/webhook")
      .send({ update_id: 1 });
    expect(res.status).toBe(404);
  });

  it("returns 404 when secret header is wrong", async () => {
    process.env["PLATFORM_TELEGRAM_WEBHOOK_SECRET"] = "correctsecret";
    const res = await request(buildTelegramApp())
      .post("/api/platform/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "wrongsecret")
      .send({ update_id: 1 });
    expect(res.status).toBe(404);
  });

  it("returns 400 when update payload is invalid", async () => {
    process.env["PLATFORM_TELEGRAM_WEBHOOK_SECRET"] = "s3cr3t";
    const res = await request(buildTelegramApp())
      .post("/api/platform/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "s3cr3t")
      .send({ not_an_update: true });
    expect(res.status).toBe(400);
  });

  it("returns 200 ok for valid update (async dispatch)", async () => {
    process.env["PLATFORM_TELEGRAM_WEBHOOK_SECRET"] = "s3cr3t";
    const res = await request(buildTelegramApp())
      .post("/api/platform/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "s3cr3t")
      .send({ update_id: 42, message: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("POST /api/platform/outbound/:agentId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when actor is none", async () => {
    const app = buildOutboundApp({ type: "none", source: "none" });
    const res = await request(app)
      .post("/api/platform/outbound/agent-1")
      .send({ channel: "telegram", target: "99", content: "hi" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent tries to send for a different agent", async () => {
    const app = buildOutboundApp({
      type: "agent",
      agentId: "agent-1",
      companyIds: ["c1"],
      source: "api_key",
    });
    const res = await request(app)
      .post("/api/platform/outbound/agent-2")
      .send({ channel: "telegram", target: "99", content: "hi" });
    expect(res.status).toBe(403);
  });

  it("returns 400 for missing body fields", async () => {
    const app = buildOutboundApp();
    const res = await request(app)
      .post("/api/platform/outbound/agent-1")
      .send({ channel: "telegram" }); // missing target + content
    expect(res.status).toBe(400);
  });

  it("returns 200 when message sent successfully (mocked outbound router)", async () => {
    const mockHandle = vi.spyOn(
      await import("../services/platform/outbound-router.js"),
      "handleOutboundMessage",
    );
    mockHandle.mockResolvedValue({ status: "sent", channel: "telegram" });

    const app = buildOutboundApp();
    const res = await request(app)
      .post("/api/platform/outbound/agent-1")
      .send({ channel: "telegram", target: "42", content: "Hello!" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channel: "telegram" });

    mockHandle.mockRestore();
  });

  it("returns 404 when agent not found (mocked outbound router)", async () => {
    const mockHandle = vi.spyOn(
      await import("../services/platform/outbound-router.js"),
      "handleOutboundMessage",
    );
    mockHandle.mockResolvedValue({ status: "no_agent" });

    const app = buildOutboundApp();
    const res = await request(app)
      .post("/api/platform/outbound/ghost")
      .send({ channel: "telegram", target: "42", content: "hi" });
    expect(res.status).toBe(404);

    mockHandle.mockRestore();
  });
});
