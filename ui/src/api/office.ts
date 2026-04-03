import type { Agent } from "@paperclipai/shared";
import { api } from "./client";
import { agentsApi } from "./agents";

export interface OfficeAgent {
  id: string;
  name: string;
  shortname: string;
  status: "active" | "paused" | "idle" | "error";
  currentTask?: string;
}

export interface OfficeLayout {
  agents: OfficeAgent[];
  gridSize: { rows: number; cols: number };
}

export function normalizeAgentStatus(status: string): OfficeAgent["status"] {
  if (status === "active" || status === "running") return "active";
  if (status === "paused") return "paused";
  if (status === "error") return "error";
  return "idle";
}

export function agentToOfficeAgent(agent: Agent): OfficeAgent {
  return {
    id: agent.id,
    name: agent.name,
    shortname: agent.urlKey
      ? agent.urlKey.slice(0, 3).toUpperCase()
      : agent.name.slice(0, 3).toUpperCase(),
    status: normalizeAgentStatus(agent.status),
  };
}

function calcGridSize(count: number): { rows: number; cols: number } {
  if (count === 0) return { rows: 0, cols: 0 };
  const cols = Math.min(count, 4);
  const rows = Math.ceil(count / cols);
  return { rows, cols };
}

export const officeApi = {
  async getLayout(companyId: string): Promise<OfficeLayout> {
    try {
      return await api.get<OfficeLayout>(`/companies/${companyId}/office-layout`);
    } catch {
      // Fallback: transform agents list into office layout
      const agents = await agentsApi.list(companyId);
      const officeAgents = agents
        .filter((a) => a.status !== "terminated")
        .map(agentToOfficeAgent);
      return {
        agents: officeAgents,
        gridSize: calcGridSize(officeAgents.length),
      };
    }
  },
};

export const officeKeys = {
  layout: (companyId: string) => ["office", "layout", companyId] as const,
};
