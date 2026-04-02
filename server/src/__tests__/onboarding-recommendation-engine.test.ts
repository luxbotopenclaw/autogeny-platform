import { describe, expect, it } from "vitest";
import {
  selectRuntime,
  selectTemplate,
  buildRecommendation,
} from "../services/onboarding/recommendation-engine.js";
import type { OnboardingDiscoveryData } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// selectRuntime
// ---------------------------------------------------------------------------

describe("selectRuntime", () => {
  it("returns hermes for coder role", () => {
    expect(selectRuntime("coder")).toBe("hermes");
  });

  it("returns hermes for developer role", () => {
    expect(selectRuntime("developer")).toBe("hermes");
  });

  it("returns hermes for engineer role", () => {
    expect(selectRuntime("engineer")).toBe("hermes");
  });

  it("returns hermes for data analyst role", () => {
    expect(selectRuntime("data analyst")).toBe("hermes");
  });

  it("returns hermes for qa role", () => {
    expect(selectRuntime("qa")).toBe("hermes");
  });

  it("returns hermes for debugging goal", () => {
    expect(selectRuntime("agent", ["debugging"])).toBe("hermes");
  });

  it("returns hermes when goals contain ml", () => {
    expect(selectRuntime("analyst", ["ml"])).toBe("hermes");
  });

  it("returns hermes for python-related role", () => {
    expect(selectRuntime("python specialist")).toBe("hermes");
  });

  it("returns openclaw for CEO role", () => {
    expect(selectRuntime("ceo")).toBe("openclaw");
  });

  it("returns openclaw for support role", () => {
    expect(selectRuntime("support")).toBe("openclaw");
  });

  it("returns openclaw for coordinator role", () => {
    expect(selectRuntime("coordinator")).toBe("openclaw");
  });

  it("returns openclaw for unknown role", () => {
    expect(selectRuntime("unknown")).toBe("openclaw");
  });

  it("returns openclaw for manager role", () => {
    expect(selectRuntime("manager")).toBe("openclaw");
  });

  it("returns openclaw for social media role", () => {
    expect(selectRuntime("social media manager")).toBe("openclaw");
  });
});

// ---------------------------------------------------------------------------
// selectTemplate
// ---------------------------------------------------------------------------

describe("selectTemplate", () => {
  it("selects solo-developer for developer industry with coding goals", () => {
    const data: OnboardingDiscoveryData = { industry: "software", goals: ["code", "build"] };
    expect(selectTemplate(data)).toBe("solo-developer");
  });

  it("selects startup-engineering for startup industry", () => {
    const data: OnboardingDiscoveryData = { industry: "startup", goals: ["engineering", "ship"] };
    expect(selectTemplate(data)).toBe("startup-engineering");
  });

  it("selects content-marketing for marketing industry with content goals", () => {
    const data: OnboardingDiscoveryData = { industry: "marketing", goals: ["content", "seo"] };
    expect(selectTemplate(data)).toBe("content-marketing");
  });

  it("selects customer-support for support-focused goals", () => {
    const data: OnboardingDiscoveryData = { industry: "support", goals: ["customer", "ticket"] };
    expect(selectTemplate(data)).toBe("customer-support");
  });

  it("selects research-team for research industry with data goals", () => {
    const data: OnboardingDiscoveryData = { industry: "research", goals: ["data", "analysis"] };
    expect(selectTemplate(data)).toBe("research-team");
  });

  it("falls back to solo-developer when no keywords match", () => {
    const data: OnboardingDiscoveryData = {};
    expect(selectTemplate(data)).toBe("solo-developer");
  });

  it("selects content-marketing for blog + seo goals", () => {
    const data: OnboardingDiscoveryData = { goals: ["seo", "blog", "social"] };
    expect(selectTemplate(data)).toBe("content-marketing");
  });

  it("selects customer-support for helpdesk goal", () => {
    const data: OnboardingDiscoveryData = { goals: ["helpdesk", "support"] };
    expect(selectTemplate(data)).toBe("customer-support");
  });
});

// ---------------------------------------------------------------------------
// buildRecommendation
// ---------------------------------------------------------------------------

describe("buildRecommendation", () => {
  it("returns valid recommendation for each template", () => {
    const inputs: OnboardingDiscoveryData[] = [
      { industry: "software", goals: ["code"] },
      { industry: "startup", goals: ["engineering"] },
      { industry: "marketing", goals: ["content"] },
      { industry: "support", goals: ["customer"] },
      { industry: "research", goals: ["data"] },
    ];

    for (const data of inputs) {
      const rec = buildRecommendation(data, "Test Company");
      expect(rec.templateKey).toBeTruthy();
      expect(rec.agents.length).toBeGreaterThan(0);
      expect(rec.companyName).toBe("Test Company");
      expect(rec.orgChart).toBeTruthy();
    }
  });

  it("assigns openclaw to CEO agent in startup template", () => {
    const data: OnboardingDiscoveryData = { industry: "startup", goals: ["engineering"] };
    const rec = buildRecommendation(data, "Startup Co");
    const ceo = rec.agents.find((a) => a.slug === "ceo");
    expect(ceo).toBeDefined();
    expect(ceo?.adapterType).toBe("openclaw");
  });

  it("assigns hermes to coder agent in solo-developer template", () => {
    const data: OnboardingDiscoveryData = { industry: "software", goals: ["code"] };
    const rec = buildRecommendation(data, "Dev Co");
    const coder = rec.agents.find((a) => a.slug === "coder");
    expect(coder).toBeDefined();
    expect(coder?.adapterType).toBe("hermes");
  });

  it("assigns hermes to analyst in research-team template", () => {
    const data: OnboardingDiscoveryData = { industry: "research", goals: ["data"] };
    const rec = buildRecommendation(data, "Research Co");
    const analyst = rec.agents.find((a) => a.slug === "analyst");
    expect(analyst).toBeDefined();
    expect(analyst?.adapterType).toBe("hermes");
  });

  it("assigns openclaw to support agent in customer-support template", () => {
    const data: OnboardingDiscoveryData = { industry: "support", goals: ["customer"] };
    const rec = buildRecommendation(data, "Support Co");
    const support = rec.agents.find((a) => a.slug === "support");
    expect(support).toBeDefined();
    expect(support?.adapterType).toBe("openclaw");
  });

  it("assigns openclaw to writer in content-marketing template", () => {
    const data: OnboardingDiscoveryData = { industry: "marketing", goals: ["content"] };
    const rec = buildRecommendation(data, "Marketing Co");
    const writer = rec.agents.find((a) => a.slug === "writer");
    expect(writer).toBeDefined();
    expect(writer?.adapterType).toBe("openclaw");
  });

  it("respects custom company name", () => {
    const data: OnboardingDiscoveryData = { goals: ["code"] };
    const rec = buildRecommendation(data, "My Custom Corp");
    expect(rec.companyName).toBe("My Custom Corp");
  });

  it("includes reportsToSlug for non-root agents", () => {
    const data: OnboardingDiscoveryData = { industry: "startup", goals: ["engineering"] };
    const rec = buildRecommendation(data, "Startup Co");
    const nonRoot = rec.agents.filter((a) => a.reportsToSlug !== null);
    expect(nonRoot.length).toBeGreaterThan(0);
  });

  it("has exactly one root agent (no reportsToSlug) in startup template", () => {
    const data: OnboardingDiscoveryData = { industry: "startup", goals: ["engineering"] };
    const rec = buildRecommendation(data, "Startup Co");
    const roots = rec.agents.filter((a) => a.reportsToSlug === null);
    expect(roots.length).toBe(1);
  });
});
