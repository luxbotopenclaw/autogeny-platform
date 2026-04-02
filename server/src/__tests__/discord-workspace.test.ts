import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  provisionUserWorkspace,
  deprovisionUserWorkspace,
  getAgentDiscordWorkspace,
} from "../services/platform/discord-workspace.js";
import type { Db } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkJson(data: Record<string, unknown>, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function makeErrorResponse(status: number, text = "Error") {
  return Promise.resolve({
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve({ message: text }),
    text: () => Promise.resolve(text),
  });
}

function buildMockDb(opts: { insertedId?: string; routings?: unknown[] } = {}) {
  const insertedId = opts.insertedId ?? "routing-1";
  const routings = opts.routings ?? [];

  const returningMock = vi.fn().mockResolvedValue([{ id: insertedId }]);
  const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  // Make where() return both a thenable array (for queries without .limit())
  // AND expose a .limit() method for queries that use it.
  const limitMock = vi.fn().mockResolvedValue(routings);
  const whereMock = vi.fn().mockReturnValue(
    Object.assign(Promise.resolve(routings), { limit: limitMock }),
  );
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockReturnValue({ where: deleteWhereMock });

  return {
    db: { insert: insertMock, select: selectMock, delete: deleteMock } as unknown as Db,
    mocks: { insert: insertMock, values: valuesMock, returning: returningMock, delete: deleteMock },
  };
}

const BASE_OPTS = {
  botToken: "bot-token",
  guildId: "guild-123",
  botClientId: "bot-client-456",
  categoryName: "Test Workspace",
};

// ---------------------------------------------------------------------------
// Tests: provisionUserWorkspace
// ---------------------------------------------------------------------------

describe("provisionUserWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("creates category, #general channel, webhook, and stores routing", async () => {
    const { db, mocks } = buildMockDb({ insertedId: "routing-uuid-1" });

    mockFetch
      .mockResolvedValueOnce(makeOkJson({ id: "cat-100", name: "Test Workspace", type: 4 }))
      .mockResolvedValueOnce(makeOkJson({ id: "chan-200", name: "general", type: 0 }))
      .mockResolvedValueOnce(makeOkJson({ id: "wh-300", token: "wh-token", url: "https://discord.com/api/webhooks/wh-300/wh-token" }));

    const result = await provisionUserWorkspace(db, "agent-1", "company-1", BASE_OPTS);

    expect(result).toEqual({
      categoryId: "cat-100",
      channelId: "chan-200",
      channelKey: "guild-123:chan-200",
      webhookUrl: "https://discord.com/api/webhooks/wh-300/wh-token",
      routingId: "routing-uuid-1",
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mocks.insert).toHaveBeenCalledOnce();

    const insertValues = mocks.values.mock.calls[0]?.[0];
    expect(insertValues.agentId).toBe("agent-1");
    expect(insertValues.companyId).toBe("company-1");
    expect(insertValues.channel).toBe("discord");
    expect(insertValues.channelKey).toBe("guild-123:chan-200");
    expect(insertValues.webhookUrl).toContain("webhooks");
  });

  it("sets @everyone deny and bot allow in permission overwrites", async () => {
    const { db } = buildMockDb({ insertedId: "r1" });
    mockFetch
      .mockResolvedValueOnce(makeOkJson({ id: "cat-100", type: 4 }))
      .mockResolvedValueOnce(makeOkJson({ id: "chan-200", type: 0 }))
      .mockResolvedValueOnce(makeOkJson({ id: "wh-1", token: "t", url: "https://discord.com/api/webhooks/wh-1/t" }));

    await provisionUserWorkspace(db, "a1", "c1", BASE_OPTS);

    const [catUrl, catInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(catUrl).toBe("https://discord.com/api/v10/guilds/guild-123/channels");
    const catBody = JSON.parse(catInit.body as string);
    const overwrites: Array<{ id: string; type: number; allow: string; deny: string }> =
      catBody.permission_overwrites;

    const everyone = overwrites.find((o) => o.id === "guild-123" && o.type === 0);
    expect(everyone).toBeDefined();
    expect(BigInt(everyone!.deny)).toBeGreaterThan(0n);
    expect(everyone!.allow).toBe("0");

    const bot = overwrites.find((o) => o.id === "bot-client-456" && o.type === 1);
    expect(bot).toBeDefined();
    expect(BigInt(bot!.allow)).toBeGreaterThan(0n);
    expect(bot!.deny).toBe("0");
  });

  it("includes discordUserId overwrite when provided", async () => {
    const { db } = buildMockDb({ insertedId: "r1" });
    mockFetch
      .mockResolvedValueOnce(makeOkJson({ id: "cat-100", type: 4 }))
      .mockResolvedValueOnce(makeOkJson({ id: "chan-200", type: 0 }))
      .mockResolvedValueOnce(makeOkJson({ id: "wh-1", token: "t", url: "https://discord.com/api/webhooks/wh-1/t" }));

    await provisionUserWorkspace(db, "a1", "c1", { ...BASE_OPTS, discordUserId: "user-discord-999" });

    const catBody = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const overwrites: Array<{ id: string }> = catBody.permission_overwrites;
    expect(overwrites.some((o) => o.id === "user-discord-999")).toBe(true);
  });

  it("throws when Discord API returns an error", async () => {
    const { db } = buildMockDb();
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403, "Missing Permissions"));

    await expect(provisionUserWorkspace(db, "a1", "c1", BASE_OPTS)).rejects.toThrow(
      "Discord API error",
    );
  });

  it("throws when DB insert returns no record", async () => {
    const returningMock = vi.fn().mockResolvedValue([]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
    const db = { insert: insertMock } as unknown as Db;

    mockFetch
      .mockResolvedValueOnce(makeOkJson({ id: "cat-100", type: 4 }))
      .mockResolvedValueOnce(makeOkJson({ id: "chan-200", type: 0 }))
      .mockResolvedValueOnce(makeOkJson({ id: "wh-1", token: "t", url: "https://discord.com/api/webhooks/wh-1/t" }));

    await expect(provisionUserWorkspace(db, "a1", "c1", BASE_OPTS)).rejects.toThrow(
      "Failed to insert channel_routing record",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: getAgentDiscordWorkspace
// ---------------------------------------------------------------------------

describe("getAgentDiscordWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when no routing exists", async () => {
    const { db } = buildMockDb({ routings: [] });
    const result = await getAgentDiscordWorkspace(db, "agent-1");
    expect(result).toBeNull();
  });

  it("returns workspace details when routing exists", async () => {
    const routing = {
      id: "routing-1",
      channelKey: "guild-123:chan-456",
      webhookUrl: "https://discord.com/api/webhooks/1/token",
    };
    const { db } = buildMockDb({ routings: [routing] });
    const result = await getAgentDiscordWorkspace(db, "agent-1");

    expect(result).toEqual({
      categoryId: "",
      channelId: "chan-456",
      channelKey: "guild-123:chan-456",
      webhookUrl: "https://discord.com/api/webhooks/1/token",
      routingId: "routing-1",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: deprovisionUserWorkspace
// ---------------------------------------------------------------------------

describe("deprovisionUserWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes routing records from DB", async () => {
    const { db, mocks } = buildMockDb({ routings: [] });
    await deprovisionUserWorkspace(db, "agent-1");
    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("deletes Discord channels when deleteChannels=true", async () => {
    const routings = [{ channelKey: "guild-123:chan-456" }];
    const { db } = buildMockDb({ routings });

    mockFetch.mockResolvedValue({ ok: true, status: 204, json: vi.fn(), text: vi.fn().mockResolvedValue("") });

    await deprovisionUserWorkspace(db, "agent-1", {
      botToken: "bot-token",
      deleteChannels: true,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("chan-456");
  });
});
