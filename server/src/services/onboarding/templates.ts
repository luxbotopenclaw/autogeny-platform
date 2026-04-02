/**
 * Onboarding Concierge — Company Templates
 *
 * Five starter company templates as Paperclip-compatible markdown packages.
 * Each template produces a set of markdown files that can be imported via
 * companyPortabilityService.importBundle() using inline source.
 */

export type TemplateKey =
  | "solo-developer"
  | "startup-engineering"
  | "content-marketing"
  | "customer-support"
  | "research-team";

export interface TemplateAgent {
  slug: string;
  name: string;
  role: string;
  title: string;
  /** "openclaw" or "hermes" */
  adapterType: "openclaw" | "hermes";
  reportsToSlug: string | null;
  skills: string[];
  description: string;
}

export interface OnboardingTemplate {
  key: TemplateKey;
  name: string;
  description: string;
  agents: TemplateAgent[];
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

export const ONBOARDING_TEMPLATES: Record<TemplateKey, OnboardingTemplate> = {
  "solo-developer": {
    key: "solo-developer",
    name: "Solo Developer",
    description: "A lean AI team for an indie developer: a project manager, a coding agent, and a research agent.",
    agents: [
      {
        slug: "pm",
        name: "Project Manager",
        role: "manager",
        title: "Project Manager",
        adapterType: "openclaw",
        reportsToSlug: null,
        skills: [],
        description: "I coordinate work, track progress, and keep the project moving. I assign tasks to the Coder and Researcher and check in on blockers.",
      },
      {
        slug: "coder",
        name: "Coder",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "hermes",
        reportsToSlug: "pm",
        skills: [],
        description: "I write, review, and debug code. I have access to sandboxed terminals and git, and I learn your codebase patterns over time.",
      },
      {
        slug: "researcher",
        name: "Researcher",
        role: "agent",
        title: "Research Specialist",
        adapterType: "openclaw",
        reportsToSlug: "pm",
        skills: [],
        description: "I browse the web, read documentation, and summarize findings. I help you stay informed about technologies and solutions relevant to your work.",
      },
    ],
  },

  "startup-engineering": {
    key: "startup-engineering",
    name: "Startup Engineering",
    description: "A small engineering team for a startup shipping fast: CEO, CTO, two developers, and a QA agent.",
    agents: [
      {
        slug: "ceo",
        name: "CEO",
        role: "ceo",
        title: "Chief Executive Officer",
        adapterType: "openclaw",
        reportsToSlug: null,
        skills: [],
        description: "I set priorities, coordinate the team, communicate with stakeholders, and keep everyone aligned on the mission.",
      },
      {
        slug: "cto",
        name: "CTO",
        role: "cto",
        title: "Chief Technology Officer",
        adapterType: "hermes",
        reportsToSlug: "ceo",
        skills: [],
        description: "I own the technical architecture, review code, make technology decisions, and mentor the development team.",
      },
      {
        slug: "dev-1",
        name: "Developer 1",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "hermes",
        reportsToSlug: "cto",
        skills: [],
        description: "I build features, write tests, and maintain the codebase. I specialize in backend and API development.",
      },
      {
        slug: "dev-2",
        name: "Developer 2",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "hermes",
        reportsToSlug: "cto",
        skills: [],
        description: "I build features, write tests, and maintain the codebase. I specialize in frontend and UI development.",
      },
      {
        slug: "qa",
        name: "QA Engineer",
        role: "agent",
        title: "Quality Assurance Engineer",
        adapterType: "hermes",
        reportsToSlug: "cto",
        skills: [],
        description: "I write and run automated tests, catch bugs before they ship, and ensure quality across the product.",
      },
    ],
  },

  "content-marketing": {
    key: "content-marketing",
    name: "Content Marketing",
    description: "A content creation pipeline: CEO, writer, SEO analyst, and social media manager.",
    agents: [
      {
        slug: "ceo",
        name: "CEO",
        role: "ceo",
        title: "Chief Executive Officer",
        adapterType: "openclaw",
        reportsToSlug: null,
        skills: [],
        description: "I set the content strategy, coordinate the team, and manage publishing schedules across channels.",
      },
      {
        slug: "writer",
        name: "Writer",
        role: "agent",
        title: "Content Writer",
        adapterType: "openclaw",
        reportsToSlug: "ceo",
        skills: [],
        description: "I research topics, write blog posts, articles, and long-form content, and adapt tone for different audiences.",
      },
      {
        slug: "seo",
        name: "SEO Analyst",
        role: "agent",
        title: "SEO Specialist",
        adapterType: "openclaw",
        reportsToSlug: "ceo",
        skills: [],
        description: "I research keywords, analyze search trends, optimize content for search engines, and track rankings.",
      },
      {
        slug: "social",
        name: "Social Manager",
        role: "agent",
        title: "Social Media Manager",
        adapterType: "openclaw",
        reportsToSlug: "ceo",
        skills: [],
        description: "I create social posts, schedule content across platforms, engage with the audience, and report on performance.",
      },
    ],
  },

  "customer-support": {
    key: "customer-support",
    name: "Customer Support",
    description: "A support automation team: CEO, support agent, and knowledge manager.",
    agents: [
      {
        slug: "ceo",
        name: "CEO",
        role: "ceo",
        title: "Chief Executive Officer",
        adapterType: "openclaw",
        reportsToSlug: null,
        skills: [],
        description: "I coordinate the support team, escalate complex issues, and report on support metrics.",
      },
      {
        slug: "support",
        name: "Support Agent",
        role: "agent",
        title: "Customer Support Specialist",
        adapterType: "openclaw",
        reportsToSlug: "ceo",
        skills: [],
        description: "I handle customer questions on Discord, Slack, and email. I resolve common issues quickly and escalate complex cases.",
      },
      {
        slug: "knowledge-mgr",
        name: "Knowledge Manager",
        role: "agent",
        title: "Knowledge Base Manager",
        adapterType: "openclaw",
        reportsToSlug: "ceo",
        skills: [],
        description: "I maintain the knowledge base, document solutions to recurring issues, and help the support agent find answers faster.",
      },
    ],
  },

  "research-team": {
    key: "research-team",
    name: "Research Team",
    description: "A deep research workflow: CEO, analyst, data collector, and summarizer.",
    agents: [
      {
        slug: "ceo",
        name: "CEO",
        role: "ceo",
        title: "Chief Executive Officer",
        adapterType: "openclaw",
        reportsToSlug: null,
        skills: [],
        description: "I coordinate research projects, set priorities, and deliver findings to stakeholders.",
      },
      {
        slug: "analyst",
        name: "Analyst",
        role: "agent",
        title: "Data Analyst",
        adapterType: "hermes",
        reportsToSlug: "ceo",
        skills: [],
        description: "I analyze datasets, run statistical models, and extract insights using Python and data science tools.",
      },
      {
        slug: "data-collector",
        name: "Data Collector",
        role: "agent",
        title: "Data Collection Specialist",
        adapterType: "hermes",
        reportsToSlug: "ceo",
        skills: [],
        description: "I build and run data pipelines, scrape structured data, and prepare datasets for analysis.",
      },
      {
        slug: "summarizer",
        name: "Summarizer",
        role: "agent",
        title: "Research Summarizer",
        adapterType: "openclaw",
        reportsToSlug: "ceo",
        skills: [],
        description: "I synthesize research findings into clear reports and deliver summaries across communication channels.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// File builder — produces markdown package for Paperclip importBundle
// ---------------------------------------------------------------------------

function escapeYamlString(value: string): string {
  // Use double-quoted YAML strings for safety
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildCompanyMd(name: string, description: string): string {
  return [
    "---",
    `name: ${escapeYamlString(name)}`,
    `description: ${escapeYamlString(description)}`,
    "schema: agentcompanies/v1",
    "---",
    "",
  ].join("\n");
}

function buildAgentMd(agent: TemplateAgent): string {
  const lines = ["---"];
  lines.push(`name: ${escapeYamlString(agent.name)}`);
  lines.push(`title: ${escapeYamlString(agent.title)}`);
  if (agent.reportsToSlug) {
    lines.push(`reportsTo: ${agent.reportsToSlug}`);
  }
  if (agent.skills.length > 0) {
    lines.push("skills:");
    for (const skill of agent.skills) {
      lines.push(`  - ${skill}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${agent.name}`);
  lines.push("");
  lines.push(agent.description);
  lines.push("");
  return lines.join("\n");
}

function buildPaperclipYaml(agents: TemplateAgent[]): string {
  const lines = ["agents:"];
  for (const agent of agents) {
    lines.push(`  ${agent.slug}:`);
    lines.push(`    role: ${agent.role}`);
    lines.push(`    adapter:`);
    lines.push(`      type: ${agent.adapterType}`);
    lines.push(`      config: {}`);
    lines.push(`    runtime: {}`);
    lines.push(`    permissions: {}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Builds the set of inline markdown files required by companyPortabilityService.importBundle().
 */
export function buildTemplateFiles(
  template: OnboardingTemplate,
  customCompanyName?: string,
): Record<string, string> {
  const companyName = customCompanyName ?? template.name;
  const files: Record<string, string> = {};

  files["COMPANY.md"] = buildCompanyMd(companyName, template.description);

  for (const agent of template.agents) {
    files[`agents/${agent.slug}/AGENTS.md`] = buildAgentMd(agent);
  }

  files[".paperclip.yaml"] = buildPaperclipYaml(template.agents);

  return files;
}
