import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export interface OnboardingDiscoveryData {
  industry?: string;
  teamSize?: string;
  goals?: string[];
  tools?: string[];
  sophistication?: string;
  recommendationReady?: boolean;
  rawMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OnboardingRecommendationData {
  templateKey: string;
  companyName: string;
  agents: Array<{
    slug: string;
    name: string;
    role: string;
    adapterType: string;
    skills: string[];
    reportsToSlug: string | null;
  }>;
  orgChart: string;
}

export const onboardingSessions = pgTable("onboarding_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"),
  discoveryData: jsonb("discovery_data").$type<OnboardingDiscoveryData>(),
  recommendationData: jsonb("recommendation_data").$type<OnboardingRecommendationData>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
