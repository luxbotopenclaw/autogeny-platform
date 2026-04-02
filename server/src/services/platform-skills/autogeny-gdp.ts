/**
 * autogeny-gdp — Platform skill for Geny Delegation Protocol (GDP) task delegation.
 *
 * Exposes `autogeny_gdp_delegate` which queues a task to the Autogeny GDP
 * endpoint and returns the job ID and status URL for polling.
 *
 * Authentication: uses AUTOGENY_INTERNAL_SECRET env var to authenticate with
 * the GDP service. If absent, the tool call fails with a clear error.
 */

import type { Db } from "@paperclipai/db";
import { companySkills } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { PlatformSkill, SkillContext, ToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SKILL_ID = "autogeny-gdp";

const GDP_BASE_URL = process.env.AUTOGENY_API_URL ?? "http://localhost:3001";
const GDP_JOBS_PATH = "/api/gdp/jobs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GdpDelegateParams {
  task: string;
  targetAgentId?: string;
}

export interface GdpJobCreatePayload {
  task: string;
  targetAgentId?: string;
  sourceAgentId?: string;
  companyId?: string;
}

export interface GdpJobResult {
  jobId: string;
  statusUrl: string;
  status: string;
}

// ---------------------------------------------------------------------------
// GDP delegation logic
// ---------------------------------------------------------------------------

/**
 * Create a GDP job via the Autogeny API.
 * Exported for unit testing.
 */
export async function createGdpJob(
  payload: GdpJobCreatePayload,
  internalSecret: string,
  fetchFn: typeof fetch = fetch,
): Promise<GdpJobResult> {
  const url = `${GDP_BASE_URL}${GDP_JOBS_PATH}`;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": internalSecret,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GDP job creation failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
    );
  }

  const data = (await response.json()) as { id?: string; jobId?: string; status?: string };
  const jobId = data.id ?? data.jobId;
  if (!jobId) {
    throw new Error("GDP job creation: response missing job ID");
  }

  return {
    jobId,
    statusUrl: `${GDP_BASE_URL}${GDP_JOBS_PATH}/${jobId}`,
    status: data.status ?? "queued",
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const toolDefinitions: ToolDefinition[] = [
  {
    name: "autogeny_gdp_delegate",
    displayName: "Autogeny GDP Delegate",
    description:
      "Delegate a task to another agent via the Autogeny Geny Delegation Protocol (GDP). " +
      "The task is placed in the GDP queue and processed asynchronously. " +
      "Returns a job ID and status URL so you can track progress. " +
      "Optionally specify a target agent ID to route the task to a specific agent.",
    parametersSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task description to delegate.",
        },
        targetAgentId: {
          type: "string",
          description:
            "Optional. The ID of the agent to delegate the task to. " +
            "If omitted, the GDP system routes the task automatically.",
        },
      },
      required: ["task"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const toolHandlers: PlatformSkill["toolHandlers"] = {
  autogeny_gdp_delegate: async (params: unknown, ctx: SkillContext) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("autogeny_gdp_delegate: params must be an object");
    }
    const { task, targetAgentId } = params as GdpDelegateParams;

    if (!task || typeof task !== "string" || task.trim() === "") {
      throw new Error("autogeny_gdp_delegate: 'task' must be a non-empty string");
    }
    if (targetAgentId !== undefined && typeof targetAgentId !== "string") {
      throw new Error("autogeny_gdp_delegate: 'targetAgentId' must be a string when provided");
    }

    const internalSecret = process.env.AUTOGENY_INTERNAL_SECRET;
    if (!internalSecret) {
      throw new Error(
        "autogeny_gdp_delegate: AUTOGENY_INTERNAL_SECRET environment variable is not set. " +
          "Configure this on the platform server to enable GDP delegation.",
      );
    }

    const result = await createGdpJob(
      {
        task,
        targetAgentId,
        sourceAgentId: ctx.agentId,
        companyId: ctx.companyId,
      },
      internalSecret,
    );

    return result;
  },
};

// ---------------------------------------------------------------------------
// installForCompany
// ---------------------------------------------------------------------------

const SKILL_MARKDOWN = `# Autogeny GDP (Geny Delegation Protocol)

Use the \`autogeny_gdp_delegate\` tool to delegate tasks to other agents via
the Autogeny Geny Delegation Protocol (GDP). Tasks are queued and processed
asynchronously.

## Tool: \`autogeny_gdp_delegate\`

**Parameters:**
- \`task\` *(required, string)* — the task to delegate
- \`targetAgentId\` *(optional, string)* — the target agent ID; if omitted, GDP routes automatically

**Returns:**
\`\`\`json
{
  "jobId": "string",
  "statusUrl": "string",
  "status": "queued" | "running" | "done" | "failed"
}
\`\`\`

**Example:**
\`\`\`json
{
  "task": "Summarize the latest pull requests and post to #engineering-updates",
  "targetAgentId": "agent-uuid-here"
}
\`\`\`

After delegation, poll the \`statusUrl\` to check job progress.
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
    slug: "autogeny-gdp",
    name: "Autogeny GDP Task Delegation",
    description: "Delegate tasks to other agents via the Geny Delegation Protocol",
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

export const autogenyGdpSkill: PlatformSkill = {
  skillId: SKILL_ID,
  toolDefinitions,
  toolHandlers,
  installForCompany,
};
