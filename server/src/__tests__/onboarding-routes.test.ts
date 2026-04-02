/**
 * Onboarding routes — API tests
 *
 * Pattern mirrors company-skills-routes.test.ts:
 * - vi.hoisted mocks for services
 * - createApp helper with injected actor
 * - supertest for HTTP assertions
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingRoutes } from "../routes/onboarding.js";
import { errorHandler } from "../middleware/index.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockConciergeService = vi.hoisted(() => ({
  startSession: vi.fn(),
  processMessage: vi.fn(),
  getSession: vi.fn(),
  provisionTeam: vi.fn(),
  generateRecommendation: vi.fn(),
}));

const mockPortabilityService = vi.hoisted(() => ({
  importBundle: vi.fn(),
}));

vi.mock("../services/onboarding/concierge.js", () => ({
  onboardingConciergeService: () => mockConciergeService,
}));

vi.mock("../services/index.js", () => ({
  companyPortabilityService: () => mockPortabilityService,
}));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api/onboarding", onboardingRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-123",
  source: "session",
  isInstanceAdmin: false,
};

const noActor = { type: "none", source: "none" };

// ---------------------------------------------------------------------------
// POST /start
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/start", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a session for an authenticated board user", async () => {
    mockConciergeService.startSession.mockResolvedValue("session-abc");

    const res = await request(createApp(boardActor))
      .post("/api/onboarding/start")
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe("session-abc");
    expect(mockConciergeService.startSession).toHaveBeenCalledWith("user-123");
  });

  it("returns 403 for unauthenticated requests", async () => {
    const res = await request(createApp(noActor))
      .post("/api/onboarding/start")
      .send({});

    expect(res.status).toBe(403);
    expect(mockConciergeService.startSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /:sessionId/message
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/:sessionId/message", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a message and returns a concierge response", async () => {
    mockConciergeService.processMessage.mockResolvedValue({
      response: "What type of business are you in?",
      stage: "industry",
      isComplete: false,
    });

    const res = await request(createApp(boardActor))
      .post("/api/onboarding/session-1/message")
      .send({ message: "Hello, I want to set up my AI team" });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe("What type of business are you in?");
    expect(res.body.stage).toBe("industry");
    expect(res.body.isComplete).toBe(false);
    expect(mockConciergeService.processMessage).toHaveBeenCalledWith(
      "session-1",
      "Hello, I want to set up my AI team",
      "user-123",
    );
  });

  it("returns 400 when message is missing", async () => {
    const res = await request(createApp(boardActor))
      .post("/api/onboarding/session-1/message")
      .send({});

    expect(res.status).toBe(400);
    expect(mockConciergeService.processMessage).not.toHaveBeenCalled();
  });

  it("returns 400 when message is empty string", async () => {
    const res = await request(createApp(boardActor))
      .post("/api/onboarding/session-1/message")
      .send({ message: "   " });

    expect(res.status).toBe(400);
  });

  it("returns 403 for unauthenticated requests", async () => {
    const res = await request(createApp(noActor))
      .post("/api/onboarding/session-1/message")
      .send({ message: "Hello" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /:sessionId
// ---------------------------------------------------------------------------

describe("GET /api/onboarding/:sessionId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the session for the owner", async () => {
    const fakeSession = { id: "session-1", status: "active", userId: "user-123" };
    mockConciergeService.getSession.mockResolvedValue(fakeSession);

    const res = await request(createApp(boardActor))
      .get("/api/onboarding/session-1");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("session-1");
    expect(mockConciergeService.getSession).toHaveBeenCalledWith("session-1", "user-123");
  });

  it("returns 404 when session is not found", async () => {
    mockConciergeService.getSession.mockResolvedValue(null);

    const res = await request(createApp(boardActor))
      .get("/api/onboarding/session-999");

    expect(res.status).toBe(404);
  });

  it("returns 403 for unauthenticated requests", async () => {
    const res = await request(createApp(noActor))
      .get("/api/onboarding/session-1");

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /:sessionId/provision
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/:sessionId/provision", () => {
  beforeEach(() => vi.clearAllMocks());

  it("provisions team and returns the new companyId", async () => {
    mockConciergeService.provisionTeam.mockResolvedValue("company-xyz");

    const res = await request(createApp(boardActor))
      .post("/api/onboarding/session-1/provision")
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe("company-xyz");
  });

  it("passes custom company name to provisionTeam", async () => {
    mockConciergeService.provisionTeam.mockResolvedValue("company-xyz");

    await request(createApp(boardActor))
      .post("/api/onboarding/session-1/provision")
      .send({ companyName: "Acme Corp" });

    expect(mockConciergeService.provisionTeam).toHaveBeenCalledWith(
      "session-1",
      "user-123",
      expect.any(Function),
      "Acme Corp",
    );
  });

  it("does not pass company name when it is absent", async () => {
    mockConciergeService.provisionTeam.mockResolvedValue("company-xyz");

    await request(createApp(boardActor))
      .post("/api/onboarding/session-1/provision")
      .send({});

    expect(mockConciergeService.provisionTeam).toHaveBeenCalledWith(
      "session-1",
      "user-123",
      expect.any(Function),
      undefined,
    );
  });

  it("returns 403 for unauthenticated requests", async () => {
    const res = await request(createApp(noActor))
      .post("/api/onboarding/session-1/provision")
      .send({});

    expect(res.status).toBe(403);
  });
});
