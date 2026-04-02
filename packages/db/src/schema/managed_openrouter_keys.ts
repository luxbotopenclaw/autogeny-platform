import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Tracks platform-managed OpenRouter sub-keys.
 * - One record per agent (agentId non-null) for per-agent sub-keys.
 * - One record per company (agentId null) for the company-level admin key entry.
 *
 * The encrypted key material lives in company_secrets / company_secret_versions.
 * This table holds OpenRouter-specific metadata: the provider key ID, spending cap,
 * and last-known usage for delta-based cost_event insertion.
 */
export const managedOpenRouterKeys = pgTable(
  "managed_openrouter_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** null = company-level admin key, non-null = per-agent sub-key */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    /** FK to company_secrets row that holds the encrypted key material */
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    /** OpenRouter's own key identifier (e.g. "key-abc123") — used for API calls */
    providerKeyId: text("provider_key_id").notNull(),
    /** Hard spending cap for this key in USD cents. Default $5 = 500 cents */
    spendingCapCents: integer("spending_cap_cents").notNull().default(500),
    /** Timestamp of last successful usage poll */
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    /**
     * Total usage in USD cents as of last poll.
     * Delta = (current total) - lastKnownUsageCents → inserted as cost_event.
     */
    lastKnownUsageCents: integer("last_known_usage_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("managed_or_keys_company_idx").on(table.companyId),
    agentIdx: index("managed_or_keys_agent_idx").on(table.agentId),
    /** Enforce one managed key per agent */
    agentUq: uniqueIndex("managed_or_keys_agent_uq").on(table.agentId),
  }),
);
