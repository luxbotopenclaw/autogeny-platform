/**
 * Onboarding Concierge — Recommendation Engine
 *
 * Template-based recommendation: maps discovery dimensions to a starter
 * company template and assigns the correct runtime per agent role.
 *
 * Runtime selection rules (from spec):
 *   - communication/coordination/monitoring/browser research → openclaw
 *   - code writing/review/debugging/data analysis/ML        → hermes
 *   - CEO/PM/delegator                                      → openclaw
 *   - generic/unclear                                       → openclaw
 */

import type { OnboardingDiscoveryData, OnboardingRecommendationData } from "@paperclipai/db";
import { ONBOARDING_TEMPLATES, type TemplateKey } from "./templates.js";

// ---------------------------------------------------------------------------
// Runtime selection
// ---------------------------------------------------------------------------

/**
 * Select the optimal runtime for an agent based on its role and the team's goals.
 *
 * Returns "hermes" for code/data/ML tasks; "openclaw" for everything else.
 */
export function selectRuntime(role: string, goals: string[] = []): "openclaw" | "hermes" {
  const combined = `${role} ${goals.join(" ")}`.toLowerCase();

  const hermesPatterns = [
    "code",
    "coding",
    "coder",
    "developer",
    "engineer",
    "debug",
    "debugging",
    "data",
    "analysis",
    "analyst",
    "ml",
    "machine learning",
    "python",
    "review",
    "testing",
    "qa",
    "quality",
  ];

  for (const pattern of hermesPatterns) {
    if (combined.includes(pattern)) return "hermes";
  }

  return "openclaw";
}

// ---------------------------------------------------------------------------
// Template selection
// ---------------------------------------------------------------------------

type ScoreFn = (data: OnboardingDiscoveryData) => number;

const TEMPLATE_SCORES: Record<TemplateKey, ScoreFn> = {
  "solo-developer": (d) =>
    scoreKeywords(d, ["developer", "solo", "code", "build", "app", "software", "indie"]),
  "startup-engineering": (d) =>
    scoreKeywords(d, ["startup", "team", "engineering", "product", "ship", "saas"]),
  "content-marketing": (d) =>
    scoreKeywords(d, ["content", "marketing", "seo", "social", "brand", "writer", "blog"]),
  "customer-support": (d) =>
    scoreKeywords(d, ["support", "customer", "service", "help", "ticket", "helpdesk"]),
  "research-team": (d) =>
    scoreKeywords(d, ["research", "data", "analysis", "insights", "report", "analyst"]),
};

function scoreKeywords(data: OnboardingDiscoveryData, keywords: string[]): number {
  const text = [
    data.industry ?? "",
    data.teamSize ?? "",
    ...(data.goals ?? []),
    ...(data.tools ?? []),
    data.sophistication ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return keywords.filter((kw) => text.includes(kw)).length;
}

/**
 * Select the best matching template key for the given discovery data.
 * Falls back to "solo-developer" when no keywords match.
 */
export function selectTemplate(data: OnboardingDiscoveryData): TemplateKey {
  let bestKey: TemplateKey = "solo-developer";
  let bestScore = -1;

  for (const [key, scoreFn] of Object.entries(TEMPLATE_SCORES) as Array<[TemplateKey, ScoreFn]>) {
    const score = scoreFn(data);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  return bestKey;
}

// ---------------------------------------------------------------------------
// Recommendation builder
// ---------------------------------------------------------------------------

/**
 * Build a full recommendation from discovery data.
 */
export function buildRecommendation(
  data: OnboardingDiscoveryData,
  companyName: string,
): OnboardingRecommendationData {
  const templateKey = selectTemplate(data);
  const template = ONBOARDING_TEMPLATES[templateKey];

  const agents = template.agents.map((a) => ({
    slug: a.slug,
    name: a.name,
    role: a.role,
    adapterType: a.adapterType,
    skills: a.skills,
    reportsToSlug: a.reportsToSlug,
  }));

  // Human-readable org chart
  const orgChart = template.agents
    .map((a) => {
      const reports = a.reportsToSlug ? ` → reports to ${a.reportsToSlug}` : " (root)";
      return `${a.name} [${a.adapterType}]${reports}`;
    })
    .join("\n");

  return {
    templateKey,
    companyName,
    agents,
    orgChart,
  };
}
