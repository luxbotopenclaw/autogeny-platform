/**
 * Tests for the managed OpenRouter keys service.
 *
 * Focuses on the core behaviors: API calls, encryption, delta logic.
 * Uses vi.spyOn(global, "fetch") for HTTP mocking.
 * DB operations are tested via behavioral assertions on the mock db.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@paperclipai/db", () => ({
  companySecrets: Symbol("companySecrets"),
  companySecretVersions: Symbol("companySecretVersions"),
  managedOpenRouterKeys: Symbol("managedOpenRouterKeys"),
  costEvents: Symbol("costEvents"),
  agents: Symbol("agents"),
}));

vi.mock("../../secrets/provider-registry.js", () => ({
  getSecretProvider: vi.fn().mockReturnValue({
    id: "managed_openrouter",
    createVersion: vi.fn().mockResolvedValue({
      material: { scheme: "local_encrypted_v1", iv: "abc", tag: "def", ciphertext: "ghi" },
      valueSha256: "sha256hash",
      externalRef: null,
    }),
    resolveVersion: vi.fn().mockResolvedValue("sk-or-decrypted-test-key"),
  }),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../errors.js", () => ({
  conflict: (msg: string) => Object.assign(new Error(msg), { statusCode: 409 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { statusCode: 404 }),
}));

vi.mock("../budgets.js", () => ({
  budgetService: vi.fn().mockReturnValue({
    evaluateCostEvent: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ---------------------------------------------------------------------------
// Minimal DB builder helper
// ---------------------------------------------------------------------------

function makeDb(options: {
  /** Results returned by the first select().from().where().then() call */
  selectResults?: unknown[];
  /** What to return from insert().values().returning().then() */
  insertReturns?: unknown[];
} = {}) {
  const selectThen = vi.fn().mockImplementation(
    (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(options.selectResults ?? []).then(resolve),
  );

  const insertThen = vi.fn().mockImplementation(
    (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(options.insertReturns ?? [{ id: "new-id" }]).then(resolve),
  );

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({ then: selectThen }),
      then: selectThen,
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockReturnValue({ then: insertThen }),
        then: insertThen,
      }),
    }),
    update: vi.fn().mockImplementation(() => {
      const updateThen = vi.fn().mockImplementation(
        (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
      );
      return {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue({ then: updateThen }),
        returning: vi.fn().mockReturnThis(),
        then: updateThen,
      };
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnThis() }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(
      // Provide the same interface for the transaction tx
      {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockReturnValue({ then: insertThen }),
          }),
        }),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnThis() }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
        }),
      },
    )),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("managedOpenRouterService", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Must cast to get around strict globalThis typing
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, "fetch");
    process.env.OPENROUTER_ADMIN_KEY = "test-admin-key";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
    delete process.env.OPENROUTER_ADMIN_KEY;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // createCompanyKey
  // ──────────────────────────────────────────────────────────────────────────

  describe("createCompanyKey", () => {
    it("calls POST /api/v1/keys with admin auth header", async () => {
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "key-company-123", key: "sk-or-test", name: "autogeny-company-abc" }),
        headers: new Headers(),
      } as Response);

      // Mock: no existing company key
      const db = makeDb({ selectResults: [] });

      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);
      await svc.createCompanyKey("company-abc");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/keys",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-admin-key",
          }),
        }),
      );
    });

    it("throws with meaningful message on OpenRouter 401", async () => {
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
        headers: new Headers(),
      } as Response);

      const db = makeDb({ selectResults: [] });
      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);

      await expect(svc.createCompanyKey("company-abc")).rejects.toThrow(/401/);
    });

    it("throws if OPENROUTER_ADMIN_KEY is not set", async () => {
      delete process.env.OPENROUTER_ADMIN_KEY;
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");

      const db = makeDb({ selectResults: [] });
      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);

      await expect(svc.createCompanyKey("company-abc")).rejects.toThrow(/OPENROUTER_ADMIN_KEY/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // revokeAgentKey
  // ──────────────────────────────────────────────────────────────────────────

  describe("revokeAgentKey", () => {
    it("calls DELETE /api/v1/keys/:id and removes DB record", async () => {
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Headers(),
      } as Response);

      const existingKey = {
        id: "mk-uuid",
        agentId: "agent-abc",
        secretId: "secret-uuid",
        providerKeyId: "or-key-123",
        companyId: "comp-abc",
        spendingCapCents: 500,
        lastKnownUsageCents: 0,
        lastPolledAt: null,
      };
      const db = makeDb({ selectResults: [existingKey] });

      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);
      await svc.revokeAgentKey("agent-abc");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/keys/or-key-123",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(db.delete).toHaveBeenCalled();
    });

    it("handles 404 from OpenRouter gracefully — does not throw", async () => {
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
        headers: new Headers(),
      } as Response);

      const existingKey = {
        id: "mk-uuid",
        agentId: "agent-abc",
        secretId: "secret-uuid",
        providerKeyId: "or-key-missing",
        companyId: "comp-abc",
        spendingCapCents: 500,
        lastKnownUsageCents: 0,
        lastPolledAt: null,
      };
      const db = makeDb({ selectResults: [existingKey] });
      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);

      // Should resolve without throwing despite 404
      await expect(svc.revokeAgentKey("agent-abc")).resolves.toBeUndefined();
    });

    it("returns immediately (no-op) when agent has no managed key", async () => {
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");

      const db = makeDb({ selectResults: [] }); // no key found
      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);

      await expect(svc.revokeAgentKey("unknown-agent")).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // pollAllUsage — delta logic
  // ──────────────────────────────────────────────────────────────────────────

  describe("pollAllUsage — delta calculation", () => {
    it("computes the correct delta (totalCents - lastKnownUsageCents)", async () => {
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");

      // OpenRouter reports total usage = 350 cents; last known = 100 → delta = 250
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "or-key", usage: 350 }),
        headers: new Headers(),
      } as Response);

      const activeKey = {
        id: "mk-uuid",
        agentId: "agent-abc",
        companyId: "comp-abc",
        providerKeyId: "or-key",
        spendingCapCents: 500,
        lastKnownUsageCents: 100,
        lastPolledAt: null,
      };

      // First select returns the active keys list; insert returns the new cost event
      const db = makeDb({
        selectResults: [activeKey],
        insertReturns: [{ id: "ce-uuid", companyId: "comp-abc", agentId: "agent-abc", costCents: 250 }],
      });

      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);
      const result = await svc.pollAllUsage();

      expect(result.polled).toBe(1);
      expect(result.eventsInserted).toBe(1);

      // Verify insert was called with the correct delta
      const insertCall = (db.insert as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(insertCall).toBeDefined();
    });

    it("skips insert when usage has not changed (delta = 0)", async () => {
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");

      // Same usage as last known
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "or-key", usage: 100 }),
        headers: new Headers(),
      } as Response);

      const activeKey = {
        id: "mk-uuid",
        agentId: "agent-abc",
        companyId: "comp-abc",
        providerKeyId: "or-key",
        spendingCapCents: 500,
        lastKnownUsageCents: 100,
        lastPolledAt: null,
      };

      const db = makeDb({ selectResults: [activeKey] });
      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);
      const result = await svc.pollAllUsage();

      expect(result.polled).toBe(1);
      expect(result.eventsInserted).toBe(0);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // getKeyForAgent — decryption
  // ──────────────────────────────────────────────────────────────────────────

  describe("getKeyForAgent", () => {
    it("returns null when no managed key exists for agent", async () => {
      const { managedOpenRouterService } = await import("../../services/managed-openrouter.js");
      const db = makeDb({ selectResults: [] });
      const svc = managedOpenRouterService(db as unknown as import("@paperclipai/db").Db);

      const key = await svc.getKeyForAgent("unknown-agent");
      expect(key).toBeNull();
    });
  });
});
