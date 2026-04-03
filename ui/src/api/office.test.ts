import { describe, expect, it } from "vitest";
import { normalizeAgentStatus, agentToOfficeAgent } from "./office";
import type { Agent } from "@paperclipai/shared";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Alpha",
    urlKey: "alpha",
    status: "active",
    adapterType: "claude_local",
    icon: null,
    title: null,
    companyId: "company-1",
    role: "worker",
    canCreateAgents: false,
    canAssignTasks: false,
    issuePrefix: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as unknown as Agent;
}

describe("normalizeAgentStatus", () => {
  it("maps active to active", () => {
    expect(normalizeAgentStatus("active")).toBe("active");
  });

  it("maps running to active", () => {
    expect(normalizeAgentStatus("running")).toBe("active");
  });

  it("maps paused to paused", () => {
    expect(normalizeAgentStatus("paused")).toBe("paused");
  });

  it("maps error to error", () => {
    expect(normalizeAgentStatus("error")).toBe("error");
  });

  it("maps terminated and unknown to idle", () => {
    expect(normalizeAgentStatus("terminated")).toBe("idle");
    expect(normalizeAgentStatus("unknown")).toBe("idle");
  });
});

describe("agentToOfficeAgent", () => {
  it("maps id and name correctly", () => {
    const agent = makeAgent({ id: "a1", name: "Beta" });
    const result = agentToOfficeAgent(agent);
    expect(result.id).toBe("a1");
    expect(result.name).toBe("Beta");
  });

  it("uses urlKey for shortname", () => {
    const agent = makeAgent({ urlKey: "charlie" });
    const result = agentToOfficeAgent(agent);
    expect(result.shortname).toBe("CHA");
  });

  it("falls back to name slice when urlKey is empty", () => {
    const agent = makeAgent({ name: "Delta Bot", urlKey: "" });
    const result = agentToOfficeAgent(agent);
    expect(result.shortname).toBe("DEL");
  });

  it("normalizes status via normalizeAgentStatus", () => {
    const agent = makeAgent({ status: "running" });
    expect(agentToOfficeAgent(agent).status).toBe("active");
  });
});
