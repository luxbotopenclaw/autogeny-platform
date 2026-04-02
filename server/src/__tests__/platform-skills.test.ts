/**
 * Unit tests for Autogeny Platform Skills
 *
 * Tests cover:
 * - autogeny-search: SearXNG result parsing and limit clamping
 * - autogeny-stt: MIME type validation, base64 → file → transcription pipeline
 * - autogeny-g2g: same-company enforcement, G2G message dispatch
 * - autogeny-gdp: GDP job creation, missing secret error
 * - platformSkillRegistry: skill listing, unknown-skill errors
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runSearch,
  type SearchResult,
} from "../services/platform-skills/autogeny-search.js";
import {
  validateMimeType,
  mimeToExtension,
  transcribeBase64,
} from "../services/platform-skills/autogeny-stt.js";
import {
  sendG2GMessage,
  validateTargetAgent,
  type G2GMessagePayload,
} from "../services/platform-skills/autogeny-g2g.js";
import {
  createGdpJob,
  type GdpJobCreatePayload,
} from "../services/platform-skills/autogeny-gdp.js";
import { platformSkillRegistry } from "../services/platform-skills/index.js";
import type { SkillContext } from "../services/platform-skills/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    db: {} as any,
    companyId: "company-1",
    agentId: "agent-1",
    gatewayToken: "token-abc",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// autogeny-search
// ---------------------------------------------------------------------------

describe("autogeny-search", () => {
  describe("runSearch", () => {
    it("returns parsed results for a valid SearXNG response", async () => {
      const mockResponse = {
        results: [
          { title: "TypeScript 5.4", url: "https://devblogs.microsoft.com/ts54", content: "New in 5.4..." },
          { title: "TypeScript Docs", url: "https://typescriptlang.org", content: "Official docs..." },
          { title: "TypeScript GitHub", url: "https://github.com/microsoft/typescript", content: "Source code..." },
        ],
      };
      const fetchFn = makeMockFetch(200, mockResponse);
      const results = await runSearch({ query: "typescript", limit: 3 }, fetchFn);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual<SearchResult>({
        title: "TypeScript 5.4",
        url: "https://devblogs.microsoft.com/ts54",
        content: "New in 5.4...",
      });
    });

    it("respects the limit parameter", async () => {
      const mockResponse = {
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `Result ${i}`,
          url: `https://example.com/${i}`,
          content: `Content ${i}`,
        })),
      };
      const fetchFn = makeMockFetch(200, mockResponse);
      const results = await runSearch({ query: "test", limit: 2 }, fetchFn);
      expect(results).toHaveLength(2);
    });

    it("clamps limit to MAX_RESULT_LIMIT (20)", async () => {
      const mockResponse = {
        results: Array.from({ length: 25 }, (_, i) => ({
          title: `Result ${i}`,
          url: `https://example.com/${i}`,
          content: `Content ${i}`,
        })),
      };
      const fetchFn = makeMockFetch(200, mockResponse);
      const results = await runSearch({ query: "test", limit: 999 }, fetchFn);
      expect(results).toHaveLength(20);
    });

    it("returns empty array when results is missing", async () => {
      const fetchFn = makeMockFetch(200, {});
      const results = await runSearch({ query: "test" }, fetchFn);
      expect(results).toEqual([]);
    });

    it("throws on non-200 response", async () => {
      const fetchFn = makeMockFetch(503, { error: "Service unavailable" });
      await expect(runSearch({ query: "test" }, fetchFn)).rejects.toThrow(
        "SearXNG request failed: HTTP 503",
      );
    });

    it("uses fallback values for missing title/url/content", async () => {
      const mockResponse = {
        results: [{}],
      };
      const fetchFn = makeMockFetch(200, mockResponse);
      const results = await runSearch({ query: "test" }, fetchFn);
      expect(results[0]).toEqual({ title: "(no title)", url: "", content: "" });
    });
  });
});

// ---------------------------------------------------------------------------
// autogeny-stt
// ---------------------------------------------------------------------------

describe("autogeny-stt", () => {
  describe("validateMimeType", () => {
    it("accepts audio/* MIME types", () => {
      expect(() => validateMimeType("audio/wav")).not.toThrow();
      expect(() => validateMimeType("audio/mpeg")).not.toThrow();
      expect(() => validateMimeType("audio/webm")).not.toThrow();
    });

    it("accepts video/* MIME types", () => {
      expect(() => validateMimeType("video/mp4")).not.toThrow();
      expect(() => validateMimeType("video/webm")).not.toThrow();
    });

    it("rejects non-audio/video MIME types", () => {
      expect(() => validateMimeType("image/jpeg")).toThrow("unsupported mimeType");
      expect(() => validateMimeType("application/pdf")).toThrow("unsupported mimeType");
      expect(() => validateMimeType("text/plain")).toThrow("unsupported mimeType");
    });
  });

  describe("mimeToExtension", () => {
    it("maps common audio types to extensions", () => {
      expect(mimeToExtension("audio/wav")).toBe("wav");
      expect(mimeToExtension("audio/mpeg")).toBe("mp3");
      expect(mimeToExtension("audio/mp4")).toBe("m4a");
      expect(mimeToExtension("audio/ogg")).toBe("ogg");
      expect(mimeToExtension("audio/webm")).toBe("webm");
    });

    it("maps video types to extensions", () => {
      expect(mimeToExtension("video/mp4")).toBe("mp4");
      expect(mimeToExtension("video/webm")).toBe("webm");
    });

    it("falls back to 'bin' for unknown types", () => {
      expect(mimeToExtension("audio/unknown-format")).toBe("bin");
    });

    it("strips parameters from MIME type before lookup", () => {
      expect(mimeToExtension("audio/wav; codecs=pcm")).toBe("wav");
    });
  });

  describe("transcribeBase64", () => {
    it("throws on invalid MIME type", async () => {
      await expect(
        transcribeBase64({ audioBase64: "AAAA", mimeType: "image/png" }),
      ).rejects.toThrow("unsupported mimeType");
    });

    it("throws on invalid base64 characters", async () => {
      await expect(
        transcribeBase64({
          audioBase64: "not valid base64!!!###",
          mimeType: "audio/wav",
        }),
      ).rejects.toThrow("not valid base64");
    });

    it("returns transcript from exec output", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        stdout: "Hello world transcript",
        stderr: "",
      });

      const transcript = await transcribeBase64(
        { audioBase64: "AAAA", mimeType: "audio/wav" },
        mockExec as any,
      );

      expect(transcript).toBe("Hello world transcript");
      expect(mockExec).toHaveBeenCalledOnce();
      const [bin, args] = mockExec.mock.calls[0] as [string, string[]];
      expect(typeof bin).toBe("string");
      expect(args[0]).toContain("transcribe.py");
      expect(args[1]).toMatch(/autogeny-stt-/);
    });

    it("propagates transcription errors and does not swallow them", async () => {
      // Verifies the finally-block cleanup doesn't mask the real error.
      // (Direct spy on ESM node:fs/promises is not supported by Vitest.)
      const mockExec = vi.fn().mockRejectedValue(new Error("python error"));

      await expect(
        transcribeBase64({ audioBase64: "AAAA", mimeType: "audio/wav" }, mockExec as any),
      ).rejects.toThrow("python error");
    });
  });
});

// ---------------------------------------------------------------------------
// autogeny-g2g
// ---------------------------------------------------------------------------

describe("autogeny-g2g", () => {
  describe("sendG2GMessage", () => {
    it("sends POST request with correct headers and returns result", async () => {
      const fetchFn = makeMockFetch(200, { messageId: "msg-123", status: "sent" });
      const payload: G2GMessagePayload = {
        type: "g2g_message",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        message: "Hello!",
      };
      const result = await sendG2GMessage(payload, "my-token", fetchFn);

      expect(result).toEqual({ messageId: "msg-123", status: "sent" });
      const [url, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/g2g/send");
      expect((options.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-token");

      const sentBody = JSON.parse(options.body as string);
      expect(sentBody).toMatchObject({
        type: "g2g_message",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        message: "Hello!",
      });
    });

    it("throws on non-200 response", async () => {
      const fetchFn = makeMockFetch(404, { error: "Agent not found" });
      await expect(
        sendG2GMessage(
          { type: "g2g_message", fromAgentId: "a", toAgentId: "b", message: "hi" },
          "token",
          fetchFn,
        ),
      ).rejects.toThrow("G2G send failed: HTTP 404");
    });

    it("returns fallback values when response is missing fields", async () => {
      const fetchFn = makeMockFetch(200, {});
      const result = await sendG2GMessage(
        { type: "g2g_message", fromAgentId: "a", toAgentId: "b", message: "hi" },
        "token",
        fetchFn,
      );
      expect(result.messageId).toBe("unknown");
      expect(result.status).toBe("sent");
    });
  });

  describe("validateTargetAgent", () => {
    it("throws when agent is not found", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      } as any;

      await expect(
        validateTargetAgent(mockDb, "missing-agent", "company-1"),
      ).rejects.toThrow("not found");
    });

    it("throws when agent belongs to a different company", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ id: "agent-x", companyId: "company-2" }]),
      } as any;

      // Match the actual error message from autogeny-g2g.ts
      await expect(
        validateTargetAgent(mockDb, "agent-x", "company-1"),
      ).rejects.toThrow("cross-company messaging is not allowed");
    });

    it("resolves when agent belongs to the same company", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ id: "agent-x", companyId: "company-1" }]),
      } as any;

      await expect(
        validateTargetAgent(mockDb, "agent-x", "company-1"),
      ).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// autogeny-gdp
// ---------------------------------------------------------------------------

describe("autogeny-gdp", () => {
  describe("createGdpJob", () => {
    it("creates a job and returns jobId + statusUrl", async () => {
      const fetchFn = makeMockFetch(200, { id: "job-abc", status: "queued" });
      const payload: GdpJobCreatePayload = {
        task: "Summarise the latest PR",
        sourceAgentId: "agent-1",
        companyId: "company-1",
      };
      const result = await createGdpJob(payload, "internal-secret", fetchFn);

      expect(result.jobId).toBe("job-abc");
      expect(result.statusUrl).toContain("/api/gdp/jobs/job-abc");
      expect(result.status).toBe("queued");

      const [url, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/gdp/jobs");
      expect((options.headers as Record<string, string>)["x-internal-secret"]).toBe(
        "internal-secret",
      );
    });

    it("throws when the response has no job ID", async () => {
      const fetchFn = makeMockFetch(200, { status: "queued" });
      await expect(
        createGdpJob({ task: "test" }, "secret", fetchFn),
      ).rejects.toThrow("missing job ID");
    });

    it("throws on non-200 response", async () => {
      const fetchFn = makeMockFetch(500, { error: "Internal error" });
      await expect(
        createGdpJob({ task: "test" }, "secret", fetchFn),
      ).rejects.toThrow("GDP job creation failed: HTTP 500");
    });

    it("accepts jobId field as fallback for id", async () => {
      const fetchFn = makeMockFetch(200, { jobId: "job-xyz", status: "queued" });
      const result = await createGdpJob({ task: "test" }, "secret", fetchFn);
      expect(result.jobId).toBe("job-xyz");
    });
  });

  describe("autogeny_gdp_delegate tool handler — missing AUTOGENY_INTERNAL_SECRET", () => {
    it("throws a clear error when AUTOGENY_INTERNAL_SECRET is not set", async () => {
      const originalSecret = process.env.AUTOGENY_INTERNAL_SECRET;
      delete process.env.AUTOGENY_INTERNAL_SECRET;

      const skill = platformSkillRegistry.getSkill("autogeny-gdp");
      expect(skill).toBeDefined();
      const handler = skill!.toolHandlers["autogeny_gdp_delegate"];

      await expect(
        handler({ task: "do something" }, makeCtx()),
      ).rejects.toThrow("AUTOGENY_INTERNAL_SECRET");

      if (originalSecret !== undefined) {
        process.env.AUTOGENY_INTERNAL_SECRET = originalSecret;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// platformSkillRegistry
// ---------------------------------------------------------------------------

describe("platformSkillRegistry", () => {
  it("lists all 4 skills", () => {
    const skills = platformSkillRegistry.listSkills();
    const ids = skills.map((s) => s.skillId);
    expect(ids).toContain("autogeny-search");
    expect(ids).toContain("autogeny-stt");
    expect(ids).toContain("autogeny-g2g");
    expect(ids).toContain("autogeny-gdp");
  });

  it("returns a skill by ID", () => {
    const skill = platformSkillRegistry.getSkill("autogeny-search");
    expect(skill).toBeDefined();
    expect(skill!.skillId).toBe("autogeny-search");
  });

  it("returns undefined for unknown skill ID", () => {
    expect(platformSkillRegistry.getSkill("nonexistent")).toBeUndefined();
  });

  it("throws when installing an unknown skill", async () => {
    await expect(
      platformSkillRegistry.installSkill({} as any, "company-1", "nonexistent"),
    ).rejects.toThrow("not found");
  });

  it("throws when executing a tool in an unknown skill", async () => {
    await expect(
      platformSkillRegistry.executeTool("nonexistent", "some_tool", {}, makeCtx()),
    ).rejects.toThrow("not found");
  });

  it("throws when executing an unknown tool within a known skill", async () => {
    await expect(
      platformSkillRegistry.executeTool("autogeny-search", "nonexistent_tool", {}, makeCtx()),
    ).rejects.toThrow("not found");
  });

  it("each skill has at least one tool definition matching a handler", () => {
    for (const skill of platformSkillRegistry.listSkills()) {
      for (const toolDef of skill.toolDefinitions) {
        expect(skill.toolHandlers[toolDef.name]).toBeDefined();
      }
    }
  });
});
