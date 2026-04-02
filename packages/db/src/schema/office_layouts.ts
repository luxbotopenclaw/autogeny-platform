import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const officeLayouts = pgTable(
  "office_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    layoutData: jsonb("layout_data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Partial unique index: one row per (company, user) where user is set
    companyUserIdx: uniqueIndex("office_layouts_company_user_idx")
      .on(table.companyId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    // Partial unique index: at most one default row per company (where userId IS NULL)
    companyDefaultIdx: uniqueIndex("office_layouts_company_default_idx")
      .on(table.companyId)
      .where(sql`${table.userId} IS NULL`),
    // Non-unique index for lookup performance
    companyLookupIdx: index("office_layouts_company_lookup_idx").on(table.companyId),
  }),
);
