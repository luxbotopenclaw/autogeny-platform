/**
 * Unit tests for Task 7: Slack Receiver + Workspace Provisioning
 *
 * Tests:
 *  - validateSlackSignature: valid, invalid sig, expired timestamp
 *  - buildSlackChannelName: sanitisation edge cases
 *  - webhook route: url_verification, event_callback, bot message ignored, bad sig
 *  - sendSlackMessage: correct payload, HTTP error handling
 */

import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateSlackSignature } from "../services/platform/slack-receiver.js";
import { buildSlackChannelName } from "../services/platform/slack-workspace.js";
import { slackPlatformRoutes } from "../routes/platform/slack.js";
import { errorHandler } from "../middleware/index.js";

// ─── Mock routeSlackEvent so tests don't hit the DB ──────────────────────────

const mockRouteSlackEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/platform/slack-receiver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/platform/slack-receiver.js")>();
  return { ...actual, routeSlackEvent: mockRouteSlackEvent };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSignature(secret: string, timestamp: string, body: string): string {
  const hex = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`, "utf8").digest("hex");
  return `v0=${hex}`;
}

function nowSecs(): string {
  return String(Math.floor(Date.now() / 1000));
}

// ─── validateSlackSignature ───────────────────────────────────────────────────

describe("validateSlackSignature", () => {
  const secret = "test-signing-secret-32chars000000";
  const body = '{"type":"event_callback"}';

  it("returns valid=true for a correct HMAC signature", () => {
    const ts = nowSecs();
    const result = validateSlackSignature(secret, ts, body, makeSignature(secret, ts, body));
    expect(result.valid).toBe(true);
  });

  it("returns valid=false for a tampered body", () => {
    const ts = nowSecs();
    const result = validateSlackSignature(secret, ts, body + "X", makeSignature(secret, ts, body));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it("returns valid=false for a wrong secret", () => {
    const ts = nowSecs();
    const result = validateSlackSignature(secret, ts, body, makeSignature("wrong-secret-32chars00000000000", ts, body));
    expect(result.valid).toBe(false);
  });

  it("returns valid=false when timestamp is too old (replay)", () => {
    const stale = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const result = validateSlackSignature(secret, stale, body, makeSignature(secret, stale, body));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/timestamp too old/i);
  });

  it("returns valid=false when timestamp is too far in the future", () => {
    const future = String(Math.floor(Date.now() / 1000) + 6 * 60);
    const result = validateSlackSignature(secret, future, body, makeSignature(secret, future, body));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/timestamp too old/i);
  });

  it("returns valid=false when headers are missing", () => {
    const result = validateSlackSignature(secret, "", body, "");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("returns valid=false when signing secret is empty", () => {
    const ts = nowSecs();
    const result = validateSlackSignature("", ts, body, makeSignature(secret, ts, body));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });
});

// ─── buildSlackChannelName ────────────────────────────────────────────────────

describe("buildSlackChannelName", () => {
  it("prepends autogeny- prefix", () => {
    expect(buildSlackChannelName("alice")).toBe("autogeny-alice");
  });

  it("lowercases and replaces spaces with hyphens", () => {
    expect(buildSlackChannelName("Alice Smith")).toBe("autogeny-alice-smith");
  });

  it("strips special characters", () => {
    expect(buildSlackChannelName("user@example.com")).toBe("autogeny-user-example-com");
  });

  it("collapses multiple consecutive hyphens", () => {
    expect(buildSlackChannelName("hello--world")).toBe("autogeny-hello-world");
  });

  it("falls back to autogeny-user when result is empty after sanitisation", () => {
    expect(buildSlackChannelName("!!!")).toBe("autogeny-user");
  });

  it("truncates long names to fit within Slack limits", () => {
    const longName = "a".repeat(100);
    const result = buildSlackChannelName(longName);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.startsWith("autogeny-")).toBe(true);
  });
});

// ─── Webhook route ────────────────────────────────────────────────────────────

describe("POST /api/platform/slack/webhook", () => {
  const secret = "test-secret-32characters-padding";
  const mockDb = {} as Parameters<typeof slackPlatformRoutes>[0];

  function buildApp() {
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use("/api/platform/slack", slackPlatformRoutes(mockDb));
    app.use(errorHandler);
    return app;
  }

  function makeHeaders(body: string): Record<string, string> {
    const ts = nowSecs();
    return {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": makeSignature(secret, ts, body),
    };
  }

  beforeEach(() => {
    vi.stubEnv("PLATFORM_SLACK_SIGNING_SECRET", secret);
    mockRouteSlackEvent.mockClear();
  });

  it("responds with the challenge for url_verification", async () => {
    const payload = { type: "url_verification", token: "tok", challenge: "my-challenge-xyz" };
    const body = JSON.stringify(payload);
    const res = await request(buildApp())
      .post("/api/platform/slack/webhook")
      .set(makeHeaders(body))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: "my-challenge-xyz" });
  });

  it("returns 200 immediately for event_callback", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T123",
      event_id: "Ev001",
      event_time: 1000000,
      event: { type: "message", channel: "C456", user: "U789", text: "hello", ts: "1.0" },
    };
    const body = JSON.stringify(payload);
    const res = await request(buildApp())
      .post("/api/platform/slack/webhook")
      .set(makeHeaders(body))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 200 and does not process bot messages (ignores via routeSlackEvent)", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T123",
      event_id: "Ev002",
      event_time: 1000000,
      event: { type: "message", channel: "C456", bot_id: "B001", text: "bot msg", ts: "1.1" },
    };
    const body = JSON.stringify(payload);
    const res = await request(buildApp())
      .post("/api/platform/slack/webhook")
      .set(makeHeaders(body))
      .send(payload);
    expect(res.status).toBe(200);
  });

  it("returns 401 for an invalid signature", async () => {
    const res = await request(buildApp())
      .post("/api/platform/slack/webhook")
      .set({
        "content-type": "application/json",
        "x-slack-request-timestamp": nowSecs(),
        "x-slack-signature": "v0=invalidsignature",
      })
      .send({ type: "url_verification", challenge: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 200 for unknown event types (prevents Slack retries)", async () => {
    const payload = { type: "tokens_revoked" };
    const body = JSON.stringify(payload);
    const res = await request(buildApp())
      .post("/api/platform/slack/webhook")
      .set(makeHeaders(body))
      .send(payload);
    expect(res.status).toBe(200);
  });
});

// ─── sendSlackMessage ─────────────────────────────────────────────────────────

describe("sendSlackMessage", () => {
  it("calls fetch with correct headers and body structure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, ts: "123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { sendSlackMessage } = await import("../services/platform/slack-sender.js");
    const result = await sendSlackMessage("xoxb-token", "C123", "Hello world");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer xoxb-token");
    const bodyParsed = JSON.parse(opts.body as string);
    expect(bodyParsed).toEqual({ channel: "C123", text: "Hello world" });
    expect(result.ok).toBe(true);

    vi.unstubAllGlobals();
  });

  it("throws when Slack API returns non-2xx HTTP status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
    vi.stubGlobal("fetch", fetchMock);

    const { sendSlackMessage } = await import("../services/platform/slack-sender.js");
    await expect(sendSlackMessage("token", "C123", "test")).rejects.toThrow("503");

    vi.unstubAllGlobals();
  });
});
