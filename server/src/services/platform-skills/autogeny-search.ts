/**
 * autogeny-search — Platform skill that exposes SearXNG meta-search to agents.
 *
 * Wraps the self-hosted SearXNG instance on localhost:8888 and returns
 * structured search results (title, url, content snippet).
 */

import type { Db } from "@paperclipai/db";
import { companySkills } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { PlatformSkill, SkillContext, ToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SKILL_ID = "autogeny-search";

const SEARXNG_BASE_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 20;
const MAX_QUERY_LENGTH = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
  error?: string;
}

export interface SearchParams {
  query: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Search logic
// ---------------------------------------------------------------------------

/**
 * Call SearXNG and return top-N structured results.
 * Exported for unit testing so the network call can be mocked.
 */
export async function runSearch(
  params: SearchParams,
  fetchFn: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const { query, limit = DEFAULT_RESULT_LIMIT } = params;
  const clampedLimit = Math.min(Math.max(1, limit), MAX_RESULT_LIMIT);
  const truncatedQuery = query.slice(0, MAX_QUERY_LENGTH);

  const url = new URL(`${SEARXNG_BASE_URL}/search`);
  url.searchParams.set("q", truncatedQuery);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");

  const response = await fetchFn(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`SearXNG request failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as SearXNGResponse;

  if (!Array.isArray(data.results)) {
    return [];
  }

  return data.results.slice(0, clampedLimit).map((r) => ({
    title: r.title ?? "(no title)",
    url: r.url ?? "",
    content: r.content ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const toolDefinitions: ToolDefinition[] = [
  {
    name: "autogeny_search",
    displayName: "Autogeny Search",
    description:
      "Search the web using the Autogeny platform's self-hosted SearXNG meta-search engine. " +
      "Returns up to `limit` results, each with a title, URL, and content snippet. " +
      "Use this when you need up-to-date information from the web.",
    parametersSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query string.",
          maxLength: MAX_QUERY_LENGTH,
        },
        limit: {
          type: "number",
          description: `Maximum number of results to return (1–${MAX_RESULT_LIMIT}, default ${DEFAULT_RESULT_LIMIT}).`,
          minimum: 1,
          maximum: MAX_RESULT_LIMIT,
        },
      },
      required: ["query"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const toolHandlers: PlatformSkill["toolHandlers"] = {
  autogeny_search: async (params: unknown, _ctx: SkillContext) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("autogeny_search: params must be an object");
    }
    const { query, limit } = params as SearchParams;
    if (!query || typeof query !== "string" || query.trim() === "") {
      throw new Error("autogeny_search: 'query' must be a non-empty string");
    }
    const results = await runSearch({ query, limit });
    return { results };
  },
};

// ---------------------------------------------------------------------------
// installForCompany
// ---------------------------------------------------------------------------

const SKILL_MARKDOWN = `# Autogeny Search

Use the \`autogeny_search\` tool to search the web via the Autogeny platform's
self-hosted meta-search engine (SearXNG). Results include titles, URLs, and
content snippets.

## Tool: \`autogeny_search\`

**Parameters:**
- \`query\` *(required, string, max 500 chars)* — the search query
- \`limit\` *(optional, number, 1–20, default 5)* — max results

**Returns:** \`{ results: Array<{ title: string, url: string, content: string }> }\`

**Example:**
\`\`\`json
{ "query": "latest TypeScript features", "limit": 3 }
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
    slug: "autogeny-search",
    name: "Autogeny Search",
    description: "Web search via self-hosted SearXNG meta-search engine",
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

export const autogenySearchSkill: PlatformSkill = {
  skillId: SKILL_ID,
  toolDefinitions,
  toolHandlers,
  installForCompany,
};
