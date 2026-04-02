/**
 * Managed OpenRouter Keys Service
 *
 * Platform-managed OpenRouter sub-keys (not BYOK). Provides:
 * - Admin-level key creation per company
 * - Per-agent sub-key provisioning
 * - Key revocation
 * - 15-minute usage polling → cost_events → budget enforcement
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecrets, companySecretVersions, costEvents, managedOpenRouterKeys } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { conflict, notFound } from "../errors.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { BudgetServiceHooks } from "./budgets.js";
import { budgetService } from "./budgets.js";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/**
 * Read the platform's OpenRouter admin key from the environment.
 * Throws early with a helpful message if unset.
 */
function getAdminKey(): string {
  const key = process.env.OPENROUTER_ADMIN_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error("OPENROUTER_ADMIN_KEY is not set — cannot manage OpenRouter sub-keys");
  }
  return key.trim();
}

function adminAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getAdminKey()}`,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// OpenRouter API types (minimal)
// ---------------------------------------------------------------------------

interface OpenRouterKeyCreateResponse {
  id: string;
  key: string;
  name: string;
  limit: number | null;
}

interface OpenRouterKeyGetResponse {
  id: string;
  name: string;
  usage: number;  // total USD cents used
  limit: number | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function callOpenRouterCreate(
  name: string,
  limitCents: number,
): Promise<OpenRouterKeyCreateResponse> {
  const res = await fetch(`${OPENROUTER_API_BASE}/keys`, {
    method: "POST",
    headers: adminAuthHeaders(),
    body: JSON.stringify({ name, limit: limitCents }),
  });

  if (res.status === 401) {
    logger.error("OpenRouter 401: OPENROUTER_ADMIN_KEY is invalid or expired");
    throw new Error("OpenRouter authentication failed (401) — check OPENROUTER_ADMIN_KEY");
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after") ?? "unknown";
    throw new Error(`OpenRouter rate limited (429) — retry after ${retryAfter}s`);
  }
  if (!res.ok) {
    throw new Error(`OpenRouter key creation failed: HTTP ${res.status}`);
  }

  return res.json() as Promise<OpenRouterKeyCreateResponse>;
}

async function callOpenRouterDelete(providerKeyId: string): Promise<void> {
  const res = await fetch(`${OPENROUTER_API_BASE}/keys/${providerKeyId}`, {
    method: "DELETE",
    headers: adminAuthHeaders(),
  });

  if (res.status === 404) {
    logger.warn({ providerKeyId }, "OpenRouter key not found (404) — treating as already deleted");
    return;
  }
  if (res.status === 401) {
    logger.error("OpenRouter 401: OPENROUTER_ADMIN_KEY is invalid or expired");
    throw new Error("OpenRouter authentication failed (401) — check OPENROUTER_ADMIN_KEY");
  }
  if (!res.ok) {
    throw new Error(`OpenRouter key deletion failed: HTTP ${res.status}`);
  }
}

async function callOpenRouterGetUsage(providerKeyId: string): Promise<OpenRouterKeyGetResponse | null> {
  const res = await fetch(`${OPENROUTER_API_BASE}/keys/${providerKeyId}`, {
    method: "GET",
    headers: adminAuthHeaders(),
  });

  if (res.status === 404) {
    logger.warn({ providerKeyId }, "OpenRouter key not found during usage poll — skipping");
    return null;
  }
  if (res.status === 401) {
    logger.error("OpenRouter 401 during usage poll — check OPENROUTER_ADMIN_KEY");
    return null;
  }
  if (!res.ok) {
    logger.warn({ providerKeyId, status: res.status }, "OpenRouter usage fetch failed");
    return null;
  }

  return res.json() as Promise<OpenRouterKeyGetResponse>;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function managedOpenRouterService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const svc = budgetService(db, budgetHooks);

  /**
   * Create a company-level managed OpenRouter key entry.
   * This stores the admin key reference for the company (not a sub-key).
   * Call this once per company to enable managed keys.
   *
   * @param companyId - The company UUID
   * @param opts.spendingCapCents - Hard spending cap in USD cents (default $5 = 500)
   */
  async function createCompanyKey(
    companyId: string,
    opts: {
      spendingCapCents?: number;
      actorUserId?: string | null;
    } = {},
  ): Promise<{ managedKeyId: string; secretId: string }> {
    // Check if a company-level key already exists
    const existing = await db
      .select()
      .from(managedOpenRouterKeys)
      .where(
        and(
          eq(managedOpenRouterKeys.companyId, companyId),
          isNull(managedOpenRouterKeys.agentId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      throw conflict("Company already has a managed OpenRouter key");
    }

    const spendingCapCents = opts.spendingCapCents ?? 500;
    const keyName = `autogeny-company-${companyId}`;

    // Create the sub-key on OpenRouter
    const orKey = await callOpenRouterCreate(keyName, spendingCapCents);

    // Encrypt and store in company_secrets
    const provider = getSecretProvider("managed_openrouter");
    const prepared = await provider.createVersion({
      value: orKey.key,
      externalRef: orKey.id,
    });

    return db.transaction(async (tx) => {
      // Insert company_secrets row
      const secret = await tx
        .insert(companySecrets)
        .values({
          companyId,
          name: `managed_openrouter_company_${companyId}`,
          provider: "managed_openrouter",
          externalRef: orKey.id,
          latestVersion: 1,
          description: `Platform-managed OpenRouter key for company ${companyId}`,
          createdByUserId: opts.actorUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);

      // Insert version record
      await tx.insert(companySecretVersions).values({
        secretId: secret.id,
        version: 1,
        material: prepared.material,
        valueSha256: prepared.valueSha256,
        createdByUserId: opts.actorUserId ?? null,
      });

      // Insert managed_openrouter_keys tracking row (company-level, agentId = null)
      const mkRow = await tx
        .insert(managedOpenRouterKeys)
        .values({
          companyId,
          agentId: null,
          secretId: secret.id,
          providerKeyId: orKey.id,
          spendingCapCents,
        })
        .returning()
        .then((rows) => rows[0]!);

      return { managedKeyId: mkRow.id, secretId: secret.id };
    });
  }

  /**
   * Provision a per-agent sub-key on OpenRouter and store it encrypted.
   * The agent must belong to the specified company.
   * The company must have a managed OpenRouter key already (via createCompanyKey).
   */
  async function provisionAgentKey(
    agentId: string,
    companyId: string,
    opts: {
      spendingCapCents?: number;
      actorUserId?: string | null;
    } = {},
  ): Promise<{ managedKeyId: string; secretId: string }> {
    // Verify agent belongs to company
    const agent = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found in company");

    // Check if already provisioned
    const existing = await db
      .select()
      .from(managedOpenRouterKeys)
      .where(eq(managedOpenRouterKeys.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    if (existing) throw conflict(`Agent ${agentId} already has a managed OpenRouter key`);

    const spendingCapCents = opts.spendingCapCents ?? 500;
    const keyName = `autogeny-agent-${agentId}`;

    const orKey = await callOpenRouterCreate(keyName, spendingCapCents);

    const provider = getSecretProvider("managed_openrouter");
    const prepared = await provider.createVersion({
      value: orKey.key,
      externalRef: orKey.id,
    });

    return db.transaction(async (tx) => {
      const secret = await tx
        .insert(companySecrets)
        .values({
          companyId,
          name: `managed_openrouter_agent_${agentId}`,
          provider: "managed_openrouter",
          externalRef: orKey.id,
          latestVersion: 1,
          description: `Platform-managed OpenRouter key for agent ${agent.name} (${agentId})`,
          createdByUserId: opts.actorUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);

      await tx.insert(companySecretVersions).values({
        secretId: secret.id,
        version: 1,
        material: prepared.material,
        valueSha256: prepared.valueSha256,
        createdByUserId: opts.actorUserId ?? null,
      });

      const mkRow = await tx
        .insert(managedOpenRouterKeys)
        .values({
          companyId,
          agentId,
          secretId: secret.id,
          providerKeyId: orKey.id,
          spendingCapCents,
        })
        .returning()
        .then((rows) => rows[0]!);

      return { managedKeyId: mkRow.id, secretId: secret.id };
    });
  }

  /**
   * Revoke a per-agent managed OpenRouter key.
   * Deletes the key on OpenRouter (404 = graceful skip) and removes DB records.
   */
  async function revokeAgentKey(agentId: string): Promise<void> {
    const row = await db
      .select()
      .from(managedOpenRouterKeys)
      .where(eq(managedOpenRouterKeys.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    if (!row) return; // nothing to revoke

    // Delete on OpenRouter (404 handled gracefully inside callOpenRouterDelete)
    await callOpenRouterDelete(row.providerKeyId);

    // Delete DB records (cascade deletes company_secrets_versions too)
    await db.delete(companySecrets).where(eq(companySecrets.id, row.secretId));
    // managedOpenRouterKeys row deletes via cascade on company_secrets FK
  }

  /**
   * Retrieve the decrypted raw OpenRouter key for an agent.
   * Used by the runtime to inject OPENROUTER_API_KEY into agent env.
   */
  async function getKeyForAgent(agentId: string): Promise<string | null> {
    const row = await db
      .select()
      .from(managedOpenRouterKeys)
      .where(eq(managedOpenRouterKeys.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    if (!row) return null;

    const version = await db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, row.secretId),
          eq(companySecretVersions.version, 1),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!version) return null;

    const provider = getSecretProvider("managed_openrouter");
    return provider.resolveVersion({
      material: version.material as Record<string, unknown>,
      externalRef: row.providerKeyId,
    });
  }

  /**
   * Poll usage for all active per-agent managed keys.
   * For each key: fetch current total usage from OpenRouter, compute delta,
   * insert a cost_event if delta > 0, then trigger budget evaluation.
   *
   * Called by the 15-minute poller.
   */
  async function pollAllUsage(): Promise<{ polled: number; eventsInserted: number }> {
    const rows = await db
      .select()
      .from(managedOpenRouterKeys)
      .where(isNotNull(managedOpenRouterKeys.agentId));

    let eventsInserted = 0;
    const now = new Date();

    for (const row of rows) {
      try {
        const usage = await callOpenRouterGetUsage(row.providerKeyId);
        if (!usage) continue;

        // usage.usage is total USD cents consumed on this key ever
        const totalCents = Math.round(usage.usage ?? 0);
        const deltaCents = totalCents - row.lastKnownUsageCents;

        if (deltaCents > 0 && row.agentId) {
          // Insert a cost_event for the delta
          const [newEvent] = await db
            .insert(costEvents)
            .values({
              companyId: row.companyId,
              agentId: row.agentId,
              provider: "openrouter",
              biller: "managed",
              billingType: "metered_api",
              model: "managed_openrouter",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              costCents: deltaCents,
              occurredAt: now,
            })
            .returning();

          if (newEvent) {
            eventsInserted++;
            // Trigger budget enforcement for this cost event
            await svc.evaluateCostEvent(newEvent);
          }
        }

        // Always update poll state
        await db
          .update(managedOpenRouterKeys)
          .set({
            lastPolledAt: now,
            lastKnownUsageCents: totalCents,
            updatedAt: now,
          })
          .where(eq(managedOpenRouterKeys.id, row.id));
      } catch (err) {
        logger.error({ err, providerKeyId: row.providerKeyId, agentId: row.agentId }, "Failed to poll managed OpenRouter key usage");
      }
    }

    return { polled: rows.length, eventsInserted };
  }

  /**
   * List all managed OpenRouter keys for a company.
   */
  async function listForCompany(companyId: string) {
    return db
      .select({
        id: managedOpenRouterKeys.id,
        agentId: managedOpenRouterKeys.agentId,
        providerKeyId: managedOpenRouterKeys.providerKeyId,
        spendingCapCents: managedOpenRouterKeys.spendingCapCents,
        lastPolledAt: managedOpenRouterKeys.lastPolledAt,
        lastKnownUsageCents: managedOpenRouterKeys.lastKnownUsageCents,
        createdAt: managedOpenRouterKeys.createdAt,
      })
      .from(managedOpenRouterKeys)
      .where(eq(managedOpenRouterKeys.companyId, companyId));
  }

  /**
   * Start the 15-minute usage poller. Returns a cleanup function.
   */
  function startPoller(): () => void {
    const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

    const poll = async () => {
      try {
        const result = await pollAllUsage();
        logger.info(result, "Managed OpenRouter usage poll complete");
      } catch (err) {
        logger.error({ err }, "Managed OpenRouter usage poller failed");
      }
    };

    // Fire once immediately, then on schedule
    void poll();
    const handle = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => clearInterval(handle);
  }

  return {
    createCompanyKey,
    provisionAgentKey,
    revokeAgentKey,
    getKeyForAgent,
    pollAllUsage,
    listForCompany,
    startPoller,
  };
}
