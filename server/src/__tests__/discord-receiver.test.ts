import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  validateDiscordSignature,
  lookupChannelRouting,
  handleDiscordInteraction,
  type HeartbeatService,
} from "../services/platform/discord-receiver.js";
import type { Db } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Helpers: generate a real Ed25519 keypair for tests
// ---------------------------------------------------------------------------

function generateTestKeyPair() {
  return generateKeyPairSync("ed25519");
}

function signDiscordRequest(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  timestamp: string,
  body: string,
): string {
  const message = Buffer.concat([
    Buffer.from(timestamp, "utf8"),
    Buffer.from(body, "utf8"),
  ]);
  // Ed25519 doesn't use a separate digest algorithm; use crypto.sign(null, ...)
  return cryptoSign(null, message, privateKey).toString("hex");
}

function extractRawPublicKey(
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"],
): string {
  // DER-encode public key and extract raw 32 bytes (skip the 12-byte SPKI prefix)
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return der.slice(12).toString("hex");
}

// ---------------------------------------------------------------------------
// Tests: validateDiscordSignature
// ---------------------------------------------------------------------------

describe("validateDiscordSignature", () => {
  it("returns true for a valid signature", () => {
    const { privateKey, publicKey } = generateTestKeyPair();
    const publicKeyHex = extractRawPublicKey(publicKey);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordRequest(privateKey, timestamp, body);

    expect(validateDiscordSignature(Buffer.from(body), timestamp, signature, publicKeyHex)).toBe(
      true,
    );
  });

  it("returns false for a tampered body", () => {
    const { privateKey, publicKey } = generateTestKeyPair();
    const publicKeyHex = extractRawPublicKey(publicKey);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordRequest(privateKey, timestamp, body);

    expect(
      validateDiscordSignature(Buffer.from(JSON.stringify({ type: 2 })), timestamp, signature, publicKeyHex),
    ).toBe(false);
  });

  it("returns false for a wrong timestamp", () => {
    const { privateKey, publicKey } = generateTestKeyPair();
    const publicKeyHex = extractRawPublicKey(publicKey);
    const timestamp = "1000000";
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordRequest(privateKey, timestamp, body);

    expect(
      validateDiscordSignature(Buffer.from(body), "9999999", signature, publicKeyHex),
    ).toBe(false);
  });

  it("returns false for a wrong public key", () => {
    const { privateKey } = generateTestKeyPair();
    const { publicKey: otherPublicKey } = generateTestKeyPair();
    const wrongPublicKeyHex = extractRawPublicKey(otherPublicKey);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordRequest(privateKey, timestamp, body);

    expect(
      validateDiscordSignature(Buffer.from(body), timestamp, signature, wrongPublicKeyHex),
    ).toBe(false);
  });

  it("returns false for an invalid hex signature", () => {
    const { publicKey } = generateTestKeyPair();
    const publicKeyHex = extractRawPublicKey(publicKey);

    expect(
      validateDiscordSignature(Buffer.from("{}"), "1000000", "not-valid-hex!!", publicKeyHex),
    ).toBe(false);
  });

  it("returns false for an invalid public key", () => {
    expect(
      validateDiscordSignature(Buffer.from("{}"), "1000000", "aabbcc", "not-a-valid-key!!!"),
    ).toBe(false);
  });

  it("accepts both Buffer and string body", () => {
    const { privateKey, publicKey } = generateTestKeyPair();
    const publicKeyHex = extractRawPublicKey(publicKey);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordRequest(privateKey, timestamp, body);

    expect(validateDiscordSignature(body, timestamp, signature, publicKeyHex)).toBe(true);
    expect(validateDiscordSignature(Buffer.from(body), timestamp, signature, publicKeyHex)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: lookupChannelRouting
// ---------------------------------------------------------------------------

describe("lookupChannelRouting", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns routing record when found", async () => {
    const routing = { agentId: "agent-1", companyId: "company-1" };
    const limitMock = vi.fn().mockResolvedValue([routing]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const db = { select: vi.fn().mockReturnValue({ from: fromMock }) } as unknown as Db;

    const result = await lookupChannelRouting(db, "guild-1", "channel-1");
    expect(result).toEqual(routing);
  });

  it("returns null when not found", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const db = { select: vi.fn().mockReturnValue({ from: fromMock }) } as unknown as Db;

    const result = await lookupChannelRouting(db, "unknown-guild", "unknown-channel");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: handleDiscordInteraction
// ---------------------------------------------------------------------------

describe("handleDiscordInteraction", () => {
  const { privateKey, publicKey } = generateTestKeyPair();
  const publicKeyHex = extractRawPublicKey(publicKey);
  const mockHeartbeat: HeartbeatService = { wakeup: vi.fn().mockResolvedValue(undefined) };

  function makeSignedRequest(body: Record<string, unknown>) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyStr = JSON.stringify(body);
    const signature = signDiscordRequest(privateKey, timestamp, bodyStr);
    return {
      rawBody: Buffer.from(bodyStr),
      headers: {
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      },
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when signature headers are missing", async () => {
    const db = { select: vi.fn() } as unknown as Db;
    const result = await handleDiscordInteraction(db, Buffer.from("{}"), {}, mockHeartbeat, publicKeyHex);
    expect(result.status).toBe(401);
    expect((result.body as { error: string }).error).toContain("signature");
  });

  it("returns 401 for an invalid signature", async () => {
    const db = { select: vi.fn() } as unknown as Db;
    const result = await handleDiscordInteraction(
      db,
      Buffer.from(JSON.stringify({ type: 1 })),
      { "x-signature-ed25519": "deadbeef".repeat(8), "x-signature-timestamp": "1000000" },
      mockHeartbeat,
      publicKeyHex,
    );
    expect(result.status).toBe(401);
  });

  it("handles PING (type=1) and returns { type: 1 }", async () => {
    const db = { select: vi.fn() } as unknown as Db;
    const { rawBody, headers } = makeSignedRequest({ type: 1 });

    const result = await handleDiscordInteraction(db, rawBody, headers, mockHeartbeat, publicKeyHex);

    expect(result.status).toBe(200);
    expect((result.body as { type: number }).type).toBe(1);
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("routes APPLICATION_COMMAND to agent via heartbeat wakeup", async () => {
    const routing = { agentId: "agent-1", companyId: "company-1" };
    const limitMock = vi.fn().mockResolvedValue([routing]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const db = { select: vi.fn().mockReturnValue({ from: fromMock }) } as unknown as Db;

    const { rawBody, headers } = makeSignedRequest({
      type: 2,
      id: "interaction-123",
      token: "token-abc",
      guild_id: "guild-123",
      channel_id: "channel-456",
      member: { user: { id: "user-789", username: "testuser", global_name: "Test User" } },
      data: { name: "ask", options: [{ name: "question", value: "What is 2+2?" }] },
    });

    const result = await handleDiscordInteraction(db, rawBody, headers, mockHeartbeat, publicKeyHex);

    expect(result.status).toBe(200);
    expect((result.body as { type: number }).type).toBe(5); // DEFERRED_CHANNEL_MESSAGE
    expect(mockHeartbeat.wakeup).toHaveBeenCalledOnce();

    const [calledAgentId, calledOpts] = vi.mocked(mockHeartbeat.wakeup).mock.calls[0]!;
    expect(calledAgentId).toBe("agent-1");
    expect(calledOpts?.payload).toMatchObject({
      channel: "discord",
      senderId: "user-789",
      senderName: "Test User",
      metadata: { guildId: "guild-123", channelId: "channel-456" },
    });
  });

  it("returns ephemeral error when no routing found", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const db = { select: vi.fn().mockReturnValue({ from: fromMock }) } as unknown as Db;

    const { rawBody, headers } = makeSignedRequest({
      type: 2,
      guild_id: "guild-1",
      channel_id: "channel-1",
      member: { user: { id: "user-1", username: "u1" } },
      data: { name: "ask" },
    });

    const result = await handleDiscordInteraction(db, rawBody, headers, mockHeartbeat, publicKeyHex);

    expect(result.status).toBe(200);
    const body = result.body as { type: number; data?: { content: string } };
    expect(body.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(body.data?.content).toContain("No agent configured");
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("returns ephemeral error if heartbeat wakeup fails", async () => {
    const routing = { agentId: "agent-1", companyId: "company-1" };
    const limitMock = vi.fn().mockResolvedValue([routing]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const db = { select: vi.fn().mockReturnValue({ from: fromMock }) } as unknown as Db;

    const failingHb: HeartbeatService = {
      wakeup: vi.fn().mockRejectedValue(new Error("Agent is paused")),
    };

    const { rawBody, headers } = makeSignedRequest({
      type: 2,
      guild_id: "guild-1",
      channel_id: "channel-1",
      member: { user: { id: "user-1", username: "u1" } },
      data: { name: "ask" },
    });

    const result = await handleDiscordInteraction(db, rawBody, headers, failingHb, publicKeyHex);

    expect(result.status).toBe(200);
    const body = result.body as { type: number; data?: { content: string } };
    expect(body.data?.content).toContain("unavailable");
  });

  it("returns 400 for invalid JSON body (valid signature)", async () => {
    const db = { select: vi.fn() } as unknown as Db;
    const invalidBody = Buffer.from("not-json");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signDiscordRequest(privateKey, timestamp, "not-json");

    const result = await handleDiscordInteraction(
      db,
      invalidBody,
      { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
      mockHeartbeat,
      publicKeyHex,
    );

    expect(result.status).toBe(400);
  });
});
