import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { officeLayouts } from "@paperclipai/db";
import type { LayoutData } from "@paperclipai/shared";

export type OfficeLayoutRow = typeof officeLayouts.$inferSelect;

export async function getUserLayout(
  db: Db,
  companyId: string,
  userId: string,
): Promise<OfficeLayoutRow | null> {
  // Try user-specific first
  const rows = await db
    .select()
    .from(officeLayouts)
    .where(and(eq(officeLayouts.companyId, companyId), eq(officeLayouts.userId, userId)))
    .limit(1);

  if (rows.length > 0) return rows[0];

  // Fall back to company default
  return getDefaultLayout(db, companyId);
}

export async function getDefaultLayout(
  db: Db,
  companyId: string,
): Promise<OfficeLayoutRow | null> {
  const rows = await db
    .select()
    .from(officeLayouts)
    .where(and(eq(officeLayouts.companyId, companyId), isNull(officeLayouts.userId)))
    .limit(1);

  return rows[0] ?? null;
}

export async function saveUserLayout(
  db: Db,
  companyId: string,
  userId: string,
  layoutData: LayoutData,
): Promise<OfficeLayoutRow> {
  // Use DB-level upsert to avoid race conditions (INSERT ... ON CONFLICT DO UPDATE)
  const rows = await db
    .insert(officeLayouts)
    .values({ companyId, userId, layoutData: layoutData as Record<string, unknown> })
    .onConflictDoUpdate({
      target: [officeLayouts.companyId, officeLayouts.userId],
      targetWhere: sql`${officeLayouts.userId} IS NOT NULL`,
      set: {
        layoutData: layoutData as Record<string, unknown>,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0];
}

export async function saveDefaultLayout(
  db: Db,
  companyId: string,
  layoutData: LayoutData,
): Promise<OfficeLayoutRow> {
  // Use DB-level upsert to avoid race conditions (INSERT ... ON CONFLICT DO UPDATE)
  const rows = await db
    .insert(officeLayouts)
    .values({ companyId, userId: null, layoutData: layoutData as Record<string, unknown> })
    .onConflictDoUpdate({
      target: [officeLayouts.companyId],
      targetWhere: sql`${officeLayouts.userId} IS NULL`,
      set: {
        layoutData: layoutData as Record<string, unknown>,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0];
}
