/**
 * Seed script: provisions the "Autogeny Platform" system company.
 * Idempotent — safe to run multiple times.
 */
import { createDb } from "./client.js";
import { companies } from "./schema/index.js";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

export async function seedSystemCompany(db: ReturnType<typeof createDb>): Promise<void> {
  console.log("Seeding Autogeny Platform system company...");

  const existing = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.issuePrefix, "SYS"))
    .limit(1);

  if (existing.length > 0) {
    console.log(`System company already exists: ${existing[0]!.id} (${existing[0]!.name})`);
    // Ensure isSystem flag is set
    await db
      .update(companies)
      .set({ isSystem: true })
      .where(eq(companies.issuePrefix, "SYS"));
    console.log("isSystem flag confirmed.");
    return;
  }

  const [company] = await db
    .insert(companies)
    .values({
      name: "Autogeny Platform",
      description: "System company for platform-level agents (onboarding concierge, platform monitor).",
      status: "active",
      isSystem: true,
      issuePrefix: "SYS",
      budgetMonthlyCents: 0,
      requireBoardApprovalForNewAgents: false,
    })
    .returning();

  console.log(`Autogeny Platform system company created: ${company!.id}`);
}

// Self-run when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ""));
if (isMain || process.env.RUN_SEED === "1") {
  const db = createDb(url);
  await seedSystemCompany(db);
  console.log("Seed complete");
  process.exit(0);
}
