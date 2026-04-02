import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { officeLayoutRoutes } from "../routes/office-layout.js";

const mockGetUserLayout = vi.hoisted(() => vi.fn());
const mockGetDefaultLayout = vi.hoisted(() => vi.fn());
const mockSaveUserLayout = vi.hoisted(() => vi.fn());
const mockSaveDefaultLayout = vi.hoisted(() => vi.fn());
const mockGetCompanyPresence = vi.hoisted(() => vi.fn());

vi.mock("../services/office-layout.js", () => ({
  getUserLayout: mockGetUserLayout,
  getDefaultLayout: mockGetDefaultLayout,
  saveUserLayout: mockSaveUserLayout,
  saveDefaultLayout: mockSaveDefaultLayout,
}));

vi.mock("../services/claw3d-presence.js", () => ({
  getCompanyPresence: mockGetCompanyPresence,
}));

function createApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", officeLayoutRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("office layout routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/companies/:companyId/office/layout", () => {
    it("returns null when no layout exists", async () => {
      mockGetUserLayout.mockResolvedValue(null);

      const res = await request(createApp()).get("/api/companies/company-1/office/layout");

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
      expect(mockGetUserLayout).toHaveBeenCalledWith({}, "company-1", "user-1");
    });

    it("returns user layout when it exists", async () => {
      const layout = {
        id: "layout-1",
        companyId: "company-1",
        userId: "user-1",
        layoutData: { wallColor: "#fff" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockGetUserLayout.mockResolvedValue(layout);

      const res = await request(createApp()).get("/api/companies/company-1/office/layout");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(layout);
    });

    it("falls back to company default when no userId in actor", async () => {
      const defaultLayout = {
        id: "layout-default",
        companyId: "company-1",
        userId: null,
        layoutData: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockGetDefaultLayout.mockResolvedValue(defaultLayout);

      const app = createApp({ userId: null, source: "local_implicit" });
      const res = await request(app).get("/api/companies/company-1/office/layout");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(defaultLayout);
      expect(mockGetDefaultLayout).toHaveBeenCalledWith({}, "company-1");
      expect(mockGetUserLayout).not.toHaveBeenCalled();
    });

    it("returns 403 when user does not have access to company", async () => {
      const app = createApp({ companyIds: ["other-company"] });
      const res = await request(app).get("/api/companies/company-1/office/layout");
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/companies/:companyId/office/layout", () => {
    it("saves per-user layout successfully", async () => {
      const saved = {
        id: "layout-1",
        companyId: "company-1",
        userId: "user-1",
        layoutData: { wallColor: "#000" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockSaveUserLayout.mockResolvedValue(saved);

      const res = await request(createApp())
        .put("/api/companies/company-1/office/layout")
        .send({ layoutData: { wallColor: "#000" } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(saved);
      expect(mockSaveUserLayout).toHaveBeenCalledWith({}, "company-1", "user-1", {
        wallColor: "#000",
      });
    });

    it("returns 400 when no userId in actor", async () => {
      const app = createApp({ userId: null, source: "local_implicit" });

      const res = await request(app)
        .put("/api/companies/company-1/office/layout")
        .send({ layoutData: { wallColor: "#000" } });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("User authentication required to save layout");
      expect(mockSaveUserLayout).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid request body (missing layoutData)", async () => {
      const res = await request(createApp())
        .put("/api/companies/company-1/office/layout")
        .send({ notLayout: true });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(mockSaveUserLayout).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/companies/:companyId/office/layout/default", () => {
    it("returns company-wide default layout", async () => {
      const defaultLayout = {
        id: "layout-default",
        companyId: "company-1",
        userId: null,
        layoutData: { wallColor: "#ccc" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockGetDefaultLayout.mockResolvedValue(defaultLayout);

      const res = await request(createApp()).get(
        "/api/companies/company-1/office/layout/default",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(defaultLayout);
      expect(mockGetDefaultLayout).toHaveBeenCalledWith({}, "company-1");
    });

    it("returns null when no default layout exists", async () => {
      mockGetDefaultLayout.mockResolvedValue(null);

      const res = await request(createApp()).get(
        "/api/companies/company-1/office/layout/default",
      );

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });
  });

  describe("PUT /api/companies/:companyId/office/layout/default", () => {
    it("requires instance admin (403 for non-admin)", async () => {
      const res = await request(createApp())
        .put("/api/companies/company-1/office/layout/default")
        .send({ layoutData: { wallColor: "#000" } });

      expect(res.status).toBe(403);
      expect(mockSaveDefaultLayout).not.toHaveBeenCalled();
    });

    it("saves default layout for instance admin", async () => {
      const saved = {
        id: "layout-default",
        companyId: "company-1",
        userId: null,
        layoutData: { wallColor: "#000" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockSaveDefaultLayout.mockResolvedValue(saved);

      const app = createApp({ isInstanceAdmin: true });
      const res = await request(app)
        .put("/api/companies/company-1/office/layout/default")
        .send({ layoutData: { wallColor: "#000" } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(saved);
      expect(mockSaveDefaultLayout).toHaveBeenCalledWith({}, "company-1", {
        wallColor: "#000",
      });
    });
  });

  describe("GET /api/companies/:companyId/office/presence", () => {
    it("returns agent presence list", async () => {
      const presence = [
        {
          agentId: "agent-1",
          name: "Agent One",
          status: "working",
          rawStatus: "active",
          role: "general",
        },
        {
          agentId: "agent-2",
          name: "Agent Two",
          status: "idle",
          rawStatus: "idle",
          role: "reviewer",
        },
      ];
      mockGetCompanyPresence.mockResolvedValue(presence);

      const res = await request(createApp()).get(
        "/api/companies/company-1/office/presence",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(presence);
      expect(mockGetCompanyPresence).toHaveBeenCalledWith({}, "company-1");
    });
  });
});
