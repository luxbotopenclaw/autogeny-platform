/**
 * autogeny-g2g — Platform skill for Geny-to-Geny (G2G) inter-agent messaging.
 *
 * Exposes `autogeny_g2g_send` which lets a platform-managed agent send a
 * message to another agent in the same company via the OpenClaw G2G protocol.
 *
 * Security: the target agent is validated to belong to the same company as the
 * calling agent before the message is dispatched. Cross-company messaging is
 * explicitly rejected.
 */

import type { Db } from "@paperclipai/db";
import { companySkills, agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { PlatformSkill, SkillContext, ToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SKILL_ID = "autogeny-g2g";

const OPENCLAW_GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface G2GParams {
  targetAgentId: string;
  message: string;
}

export interface G2GMessagePayload {
  type: "g2g_message";
  fromAgentId: string;
  toAgentId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// G2G send logic
// ---------------------------------------------------------------------------

/**
 * Send a G2G message to a target agent.
 * Exported for unit testing.
 */
export async function sendG2GMessage(
  payload: G2GMessagePayload,
  gatewayToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ messageId: string; status: string }> {
  const url = `${OPENCLAW_GATEWAY_URL}/api/g2g/send`;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`G2G send failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`);
  }

  const data = (await response.json()) as { messageId?: string; status?: string };
  return {
    messageId: data.messageId ?? "unknown",
    status: data.status ?? "sent",
  };
}

/**
 * Validate that `targetAgentId` exists and belongs to the requesting agent's company.
 */
export async function validateTargetAgent(
  db: Db,
  targetAgentId: string,
  companyId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: agents.id, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, targetAgentId));

  if (!row) {
    throw new Error(`G2G: target agent '${targetAgentId}' not found`);
  }
  if (row.companyId !== companyId) {
    throw new Error(
      `G2G: cross-company messaging is not allowed. ` +
        `Target agent '${targetAgentId}' belongs to a different company.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const toolDefinitions: ToolDefinition[] = [
  {
    name: "autogeny_g2g_send",
    displayName: "Autogeny G2G Send",
    description:
      "Send a message to another agent in the same company using the " +
      "Geny-to-Geny (G2G) protocol. " +
      "The target agent must belong to the same company. " +
      "Use this for agent-to-agent coordination, delegation, and handoffs.",
    parametersSchema: {
      type: "object",
      properties: {
        targetAgentId: {
          type: "string",
          description: "The ID of the target agent to send the message to.",
        },
        message: {
          type: "string",
          description: "The message content to deliver to the target agent.",
        },
      },
      required: ["targetAgentId", "message"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const toolHandlers: PlatformSkill["toolHandlers"] = {
  autogeny_g2g_send: async (params: unknown, ctx: SkillContext) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("autogeny_g2g_send: params must be an object");
    }
    const { targetAgentId, message } = params as G2GParams;

    if (!targetAgentId || typeof targetAgentId !== "string") {
      throw new Error("autogeny_g2g_send: 'targetAgentId' must be a non-empty string");
    }
    if (!message || typeof message !== "string") {
      throw new Error("autogeny_g2g_send: 'message' must be a non-empty string");
    }
    if (!ctx.companyId) {
      throw new Error("autogeny_g2g_send: skill context is missing companyId");
    }
    if (!ctx.agentId) {
      throw new Error("autogeny_g2g_send: skill context is missing agentId");
    }
    if (!ctx.gatewayToken) {
      throw new Error(
        "autogeny_g2g_send: no gateway token available. " +
          "Ensure the agent has an OpenClaw gateway configured.",
      );
    }

    await validateTargetAgent(ctx.db, targetAgentId, ctx.companyId);

    const result = await sendG2GMessage(
      {
        type: "g2g_message",
        fromAgentId: ctx.agentId,
        toAgentId: targetAgentId,
        message,
      },
      ctx.gatewayToken,
    );

    return result;
  },
};

// ---------------------------------------------------------------------------
// installForCompany
// ---------------------------------------------------------------------------

const SKILL_MARKDOWN = `# Autogeny G2G (Geny-to-Geny Messaging)

Use the \`autogeny_g2g_send\` tool to send messages to other agents within your
company using the Geny-to-Geny (G2G) protocol.

> **Security:** You can only send messages to agents in the same company.
> Cross-company messaging is blocked.

## Tool: \`autogeny_g2g_send\`

**Parameters:**
- \`targetAgentId\` *(required, string)* — the ID of the target agent
- \`message\` *(required, string)* — the message to send

**Returns:** \`{ messageId: string, status: string }\`

**Example:**
\`\`\`json
{
  "targetAgentId": "agent-uuid-here",
  "message": "Please review the latest report and summarize the key findings."
}
\`\`\`
`;

async function installForCompany(db: Db, companyId: string): Promise<void> {
  const existing = await db
    .select({ id: companySkills.id })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, SKILL_ID)))
    .then((rows) => rows[0] ?? null);

  const values = {
    companyId,
    key: SKILL_ID,
    slug: "autogeny-g2g",
    name: "Autogeny G2G Messaging",
    description: "Send messages between agents in the same company via the G2G protocol",
    markdown: SKILL_MARKDOWN,
    sourceType: "platform" as const,
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "full" as const,
    compatibility: "compatible" as const,
    fileInventory: [],
    metadata: { platform: true, skillId: SKILL_ID },
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(companySkills).set(values).where(eq(companySkills.id, existing.id));
  } else {
    await db.insert(companySkills).values(values);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const autogenyG2GSkill: PlatformSkill = {
  skillId: SKILL_ID,
  toolDefinitions,
  toolHandlers,
  installForCompany,
};
