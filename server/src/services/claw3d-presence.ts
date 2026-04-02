import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

export type PresenceStatus = "working" | "idle" | "offline";

export interface AgentPresence {
  agentId: string;
  name: string;
  status: PresenceStatus;
  rawStatus: string;
  role: string;
}

export function mapAgentStatusToPresence(status: string): PresenceStatus {
  switch (status) {
    case "active":
    case "thinking":
      return "working";
    case "idle":
      return "idle";
    default:
      return "offline";
  }
}

export async function getCompanyPresence(db: Db, companyId: string): Promise<AgentPresence[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      role: agents.role,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  return rows.map((row) => ({
    agentId: row.id,
    name: row.name,
    status: mapAgentStatusToPresence(row.status),
    rawStatus: row.status,
    role: row.role,
  }));
}
