/**
 * Onboarding Concierge Service
 *
 * Core logic for the AI-powered onboarding flow:
 *   1. startSession   — idempotent; creates (or re-uses) a session for a user
 *   2. processMessage — keyword-based discovery; drives the conversation
 *   3. generateRecommendation — calls the recommendation engine
 *   4. provisionTeam  — delegates to Paperclip's importBundle
 *   5. getSession     — load + ownership-check for API handlers
 */

import { and, eq, ne } from "drizzle-orm";
import { onboardingSessions } from "@paperclipai/db";
import type { OnboardingDiscoveryData, OnboardingRecommendationData } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { CompanyPortabilityImport, CompanyPortabilityImportResult } from "@paperclipai/shared";
import { forbidden, notFound, conflict } from "../../errors.js";
import { buildRecommendation } from "./recommendation-engine.js";
import { buildTemplateFiles, ONBOARDING_TEMPLATES } from "./templates.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DISCOVERY_STAGES = [
  "greeting",
  "industry",
  "goals",
  "tools",
  "sizing",
  "complete",
] as const;

export type DiscoveryStage = (typeof DISCOVERY_STAGES)[number];

export interface ProcessMessageResult {
  response: string;
  stage: DiscoveryStage;
  isComplete: boolean;
}

/** Thin import adapter injected into provisionTeam to keep the service testable. */
export type ImportBundleFn = (
  input: CompanyPortabilityImport,
  actorUserId: string | null,
) => Promise<CompanyPortabilityImportResult>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function onboardingConciergeService(db: Db) {
  // -------------------------------------------------------------------------
  // startSession
  // -------------------------------------------------------------------------

  /**
   * Idempotent: returns the existing active session ID if one exists for the
   * user; creates a new one otherwise.
   */
  async function startSession(userId: string): Promise<string> {
    const existing = await db
      .select({ id: onboardingSessions.id, status: onboardingSessions.status })
      .from(onboardingSessions)
      .where(
        and(
          eq(onboardingSessions.userId, userId),
          ne(onboardingSessions.status, "abandoned"),
          ne(onboardingSessions.status, "complete"),
          ne(onboardingSessions.status, "provisioning"),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return existing[0]!.id;
    }

    const [session] = await db
      .insert(onboardingSessions)
      .values({
        userId,
        status: "active",
        discoveryData: {} as OnboardingDiscoveryData,
      })
      .returning({ id: onboardingSessions.id });

    return session!.id;
  }

  // -------------------------------------------------------------------------
  // processMessage
  // -------------------------------------------------------------------------

  /**
   * Process one user message through the discovery conversation.
   *
   * The conversation is keyword-driven (no live LLM call) — it extracts
   * industry/goals/tools from each message and advances through stages.
   * After 3-4 user exchanges the concierge generates a recommendation and
   * signals completion (isComplete=true).
   */
  async function processMessage(
    sessionId: string,
    message: string,
    userId: string,
  ): Promise<ProcessMessageResult> {
    const rows = await db
      .select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.id, sessionId))
      .limit(1);

    const session = rows[0];
    if (!session || session.userId !== userId) throw notFound("Onboarding session not found");

    if (session.status === "complete" || session.status === "provisioning") {
      return {
        response: "Your team is already set up! Head to your company dashboard to get started.",
        stage: "complete",
        isComplete: true,
      };
    }

    const discovery: OnboardingDiscoveryData = (session.discoveryData ?? {}) as OnboardingDiscoveryData;
    const messages: Array<{ role: "user" | "assistant"; content: string }> =
      discovery.rawMessages ?? [];

    messages.push({ role: "user", content: message });

    const lower = message.toLowerCase();

    // -- Extract industry -------------------------------------------------
    if (!discovery.industry) {
      const INDUSTRIES = [
        "tech",
        "software",
        "marketing",
        "finance",
        "operations",
        "agency",
        "healthcare",
        "ecommerce",
        "education",
        "legal",
        "creator",
        "saas",
        "startup",
      ];
      for (const ind of INDUSTRIES) {
        if (lower.includes(ind)) {
          discovery.industry = ind;
          break;
        }
      }
    }

    // -- Extract team size ------------------------------------------------
    if (!discovery.teamSize) {
      if (
        lower.includes("solo") ||
        lower.includes("just me") ||
        lower.includes("myself") ||
        lower.includes("alone") ||
        lower.includes("by myself") ||
        lower.match(/\bjust\s+i\b/)
      ) {
        discovery.teamSize = "solo";
      } else if (lower.includes("small") || lower.match(/\b[2-5]\s*(people|person|member)/)) {
        discovery.teamSize = "small";
      } else if (lower.includes("team") || lower.match(/\b[6-9]\b|\b[1-4][0-9]\b/)) {
        discovery.teamSize = "medium";
      } else if (
        lower.includes("large") ||
        lower.includes("enterprise") ||
        lower.match(/\b[5-9][0-9]\b/)
      ) {
        discovery.teamSize = "large";
      }
    }

    // -- Extract goals ----------------------------------------------------
    const GOAL_KEYWORDS = [
      "code",
      "coding",
      "content",
      "support",
      "research",
      "data",
      "marketing",
      "automate",
      "build",
      "analyze",
      "customer",
      "engineering",
      "seo",
      "social",
    ];
    const foundGoals = GOAL_KEYWORDS.filter((kw) => lower.includes(kw));
    if (foundGoals.length > 0) {
      discovery.goals = Array.from(new Set([...(discovery.goals ?? []), ...foundGoals]));
    }

    // -- Extract tools ----------------------------------------------------
    const TOOL_KEYWORDS = [
      "github",
      "gitlab",
      "slack",
      "discord",
      "linear",
      "notion",
      "jira",
      "figma",
      "vercel",
      "aws",
      "gcp",
      "azure",
    ];
    const foundTools = TOOL_KEYWORDS.filter((kw) => lower.includes(kw));
    if (foundTools.length > 0) {
      discovery.tools = Array.from(new Set([...(discovery.tools ?? []), ...foundTools]));
    }

    // -- Advance stage based on exchange count ---------------------------
    const userCount = messages.filter((m) => m.role === "user").length;

    let stage: DiscoveryStage;
    let response: string;
    let isComplete = false;

    if (userCount === 1) {
      // First message → ask about goals
      stage = "industry";
      response =
        "Great to meet you! To build your perfect AI team, I need to understand your work a bit. " +
        "What's the main thing you'd like to automate or get help with? For example: writing code, " +
        "creating content, handling customer support, or something else?";
    } else if (userCount === 2) {
      // Second message → ask about tools / team size
      stage = "goals";
      response =
        "That's helpful, thank you! Are you working solo or with a team? " +
        "And do you use any tools like GitHub, Slack, or Discord that your agents should connect with?";
    } else if (userCount === 3) {
      // Third message → generate and present recommendation
      stage = "sizing";
      const rec = buildRecommendation(discovery, deriveCompanyName(discovery));
      discovery.recommendationReady = true;

      // Persist recommendation
      await db
        .update(onboardingSessions)
        .set({
          discoveryData: { ...discovery, rawMessages: messages } as OnboardingDiscoveryData,
          recommendationData: rec,
          updatedAt: new Date(),
        })
        .where(eq(onboardingSessions.id, sessionId));

      response = buildRecommendationMessage(rec);
      return { response, stage: "complete", isComplete: true };
    } else {
      // Any further message after stage 3 → already complete
      const rec = discovery.recommendationReady
        ? (session.recommendationData as OnboardingRecommendationData)
        : buildRecommendation(discovery, deriveCompanyName(discovery));

      if (!session.recommendationData) {
        await db
          .update(onboardingSessions)
          .set({
            discoveryData: { ...discovery, rawMessages: messages } as OnboardingDiscoveryData,
            recommendationData: rec,
            updatedAt: new Date(),
          })
          .where(eq(onboardingSessions.id, sessionId));
      }

      response = buildRecommendationMessage(rec);
      return { response, stage: "complete", isComplete: true };
    }

    messages.push({ role: "assistant", content: response });

    await db
      .update(onboardingSessions)
      .set({
        discoveryData: { ...discovery, rawMessages: messages } as OnboardingDiscoveryData,
        updatedAt: new Date(),
      })
      .where(eq(onboardingSessions.id, sessionId));

    return { response, stage, isComplete };
  }

  // -------------------------------------------------------------------------
  // generateRecommendation
  // -------------------------------------------------------------------------

  /** Generate (or re-generate) the recommendation and persist it. */
  async function generateRecommendation(
    sessionId: string,
    userId: string,
  ): Promise<OnboardingRecommendationData> {
    const rows = await db
      .select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.id, sessionId))
      .limit(1);

    const session = rows[0];
    if (!session || session.userId !== userId) throw notFound("Onboarding session not found");

    const discovery = (session.discoveryData ?? {}) as OnboardingDiscoveryData;
    const rec = buildRecommendation(discovery, deriveCompanyName(discovery));

    await db
      .update(onboardingSessions)
      .set({ recommendationData: rec, updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    return rec;
  }

  // -------------------------------------------------------------------------
  // provisionTeam
  // -------------------------------------------------------------------------

  /**
   * Provision the recommended team by importing a Paperclip company package.
   *
   * @param importBundle - Injected from companyPortabilityService so this
   *   service remains testable without real DB side-effects.
   * @returns Created company ID
   */
  async function provisionTeam(
    sessionId: string,
    userId: string,
    importBundle: ImportBundleFn,
    customCompanyName?: string,
  ): Promise<string> {
    const rows = await db
      .select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.id, sessionId))
      .limit(1);

    const session = rows[0];
    if (!session || session.userId !== userId) throw notFound("Onboarding session not found");
    if (!session.recommendationData) throw conflict("Generate a recommendation before provisioning");

    // Atomic status transition to prevent double-provision (race condition guard)
    const claimed = await db
      .update(onboardingSessions)
      .set({ status: "provisioning", updatedAt: new Date() })
      .where(
        and(
          eq(onboardingSessions.id, sessionId),
          eq(onboardingSessions.status, "active"),
        ),
      )
      .returning({ id: onboardingSessions.id });

    if (claimed.length === 0) {
      throw conflict("Team has already been provisioned or is currently being provisioned");
    }

    const rec = session.recommendationData as OnboardingRecommendationData;
    const templateKey = rec.templateKey as keyof typeof ONBOARDING_TEMPLATES;
    const template = ONBOARDING_TEMPLATES[templateKey];
    if (!template) throw conflict(`Unknown template key: ${rec.templateKey}`);

    const companyName = customCompanyName ?? rec.companyName;
    const files = buildTemplateFiles(template, companyName);

    const importInput: CompanyPortabilityImport = {
      source: {
        type: "inline",
        files,
      },
      target: {
        mode: "new_company",
        newCompanyName: companyName,
      },
      include: {
        company: true,
        agents: true,
      },
    };

    const result = await importBundle(importInput, userId);

    await db
      .update(onboardingSessions)
      .set({
        companyId: result.company.id,
        status: "complete",
        updatedAt: new Date(),
      })
      .where(eq(onboardingSessions.id, sessionId));

    return result.company.id;
  }

  // -------------------------------------------------------------------------
  // getSession
  // -------------------------------------------------------------------------

  /** Load a session and verify ownership. Returns null if not found/unauthorized. */
  async function getSession(sessionId: string, userId: string) {
    const rows = await db
      .select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.id, sessionId))
      .limit(1);

    const session = rows[0];
    if (!session) return null;
    if (session.userId !== userId) return null;
    return session;
  }

  return { startSession, processMessage, generateRecommendation, provisionTeam, getSession };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveCompanyName(data: OnboardingDiscoveryData): string {
  if (data.industry) {
    const capitalised = data.industry.charAt(0).toUpperCase() + data.industry.slice(1);
    return `${capitalised} Team`;
  }
  return "My Team";
}

function buildRecommendationMessage(rec: OnboardingRecommendationData): string {
  const templateLabels: Record<string, string> = {
    "solo-developer": "Solo Developer",
    "startup-engineering": "Startup Engineering",
    "content-marketing": "Content Marketing",
    "customer-support": "Customer Support",
    "research-team": "Research Team",
  };
  const label = templateLabels[rec.templateKey] ?? rec.templateKey;

  const agentList = rec.agents
    .map((a) => `• **${a.name}** (${a.adapterType}) — ${a.role}`)
    .join("\n");

  return (
    `Based on our conversation, I recommend the **${label}** team for **${rec.companyName}**:\n\n` +
    `${agentList}\n\n` +
    `When you're ready, click **"Set up my team"** to provision these agents. ` +
    `You can always add more agents or adjust the team later!`
  );
}
