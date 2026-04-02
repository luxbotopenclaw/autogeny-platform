/**
 * Seed script: provisions the Autogeny Onboarding Concierge agent in the system company.
 * Idempotent — safe to run multiple times.
 *
 * Pattern: mirrors seed-system-company.ts
 */
import { createDb } from "./client.js";
import { companies, agents } from "./schema/index.js";
import { and, eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

export async function seedConciergeAgent(db: ReturnType<typeof createDb>): Promise<void> {
  console.log("Seeding Autogeny Onboarding Concierge agent...");

  const systemCompanyRows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.issuePrefix, "SYS"))
    .limit(1);

  const systemCompany = systemCompanyRows[0] ?? null;

  if (!systemCompany) {
    console.log("System company not found (run seed-system-company first) — skipping concierge seed.");
    return;
  }

  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, systemCompany.id),
        eq(agents.role, "concierge"),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    console.log(`Concierge agent already exists: ${existing[0]!.id}`);
    return;
  }

  const [agent] = await db
    .insert(agents)
    .values({
      companyId: systemCompany.id,
      name: "Autogeny Concierge",
      role: "concierge",
      title: "Onboarding Specialist",
      status: "active",
      adapterType: "openclaw",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      budgetMonthlyCents: 0,
    })
    .returning();

  console.log(`Concierge agent created: ${agent!.id}`);
}

// Self-run when executed directly
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ""));

if (isMain || process.env.RUN_SEED === "1") {
  const db = createDb(url);
  await seedConciergeAgent(db);
  console.log("Seed complete");
  process.exit(0);
}
