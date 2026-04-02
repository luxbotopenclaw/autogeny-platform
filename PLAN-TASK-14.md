# Task 14: Architecture Plan — Onboarding Concierge UI + Self-Organizing Mode

**Prepared by:** @plan agent
**Date:** 2026-04-02
**For:** @lead (Forge)

---

## 1. Architecture Plan

### 1.1 New Files

#### A. `ui/src/api/onboarding.ts` (~60 lines)

**Purpose:** API client for the onboarding concierge endpoints.

**Key design decision:** The API client uses the pattern `api.post<T>(path, body)` from `./client.ts`, NOT `apiClient.post`. This is critical.

```typescript
// ui/src/api/onboarding.ts
import { api } from "./client.js";

export interface OnboardingStartResponse {
  sessionId: string;
}

export interface OnboardingMessageResponse {
  response: string;
  stage: "greeting" | "industry" | "goals" | "tools" | "sizing" | "complete";
  isComplete: boolean;
}

export interface OnboardingSessionResponse {
  id: string;
  userId: string;
  status: string;
  discoveryData: Record<string, unknown> | null;
  recommendationData: {
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
  } | null;
  companyId: string | null;
}

export interface OnboardingProvisionResponse {
  companyId: string;
}

export const onboardingApi = {
  start: () => api.post<OnboardingStartResponse>("/onboarding/start", {}),

  sendMessage: (sessionId: string, message: string) =>
    api.post<OnboardingMessageResponse>(
      `/onboarding/${sessionId}/message`,
      { message }
    ),

  getSession: (sessionId: string) =>
    api.get<OnboardingSessionResponse>(`/onboarding/${sessionId}`),

  provision: (sessionId: string, companyName?: string, coordinationMode?: string) =>
    api.post<OnboardingProvisionResponse>(
      `/onboarding/${sessionId}/provision`,
      { companyName, coordinationMode }
    ),
};
```

---

#### B. `ui/src/components/OnboardingChat.tsx` (~400 lines)

**Purpose:** Chat-based onboarding UI that replaces Step 1 of the wizard for new users.

**Component structure:**

```typescript
interface OnboardingChatProps {
  onComplete: (companyId: string, companyPrefix: string) => void;
}

// State:
// - sessionId: string | null
// - messages: Array<{ role: 'user' | 'assistant'; content: string }>
// - inputValue: string
// - isLoading: boolean
// - error: string | null
// - recommendation: OnboardingSessionResponse['recommendationData'] | null
// - coordinationMode: 'auto' | 'sequential' | 'structured' (default 'auto')
// - companyName: string (editable, pre-filled from recommendation)

// Effects:
// - On mount: call onboardingApi.start() -> set sessionId
// - If start returns existing session with messages, resume from that state

// Key functions:
// - handleSendMessage(): call sendMessage API, update messages, check isComplete
// - handleProvision(): call provision API with coordinationMode, call onComplete

// Layout:
// - Full-height flex container
// - Messages area (scrollable, auto-scroll to bottom)
// - When isComplete: Right panel slides in with recommendation card
// - Bottom: Input + Send button (disabled while loading)
// - Top: Stage indicator (greeting -> industry -> goals -> sizing -> complete)
```

**Coordination Mode Selector (prominent in recommendation card):**
- Radio buttons with descriptions
- "Auto (Recommended)" selected by default
- "Self-Organizing" with research citation (14% quality boost)
- "Managed Team" for structured mode

**Styling:**
- Use `cn()` utility from `../lib/utils`
- Assistant messages: `bg-muted rounded-lg p-3`
- User messages: `bg-primary text-primary-foreground rounded-lg p-3`
- Import Lucide icons: `Sparkles`, `Send`, `Loader2`

---

#### C. `server/src/services/coordination-mode.ts` (~80 lines)

**Purpose:** Resolve coordination mode and maintain model capability registry.

```typescript
// server/src/services/coordination-mode.ts

export type CoordinationMode = "structured" | "sequential" | "auto";
export type ResolvedCoordinationMode = "structured" | "sequential";

// SWE-bench Verified approximate scores
const MODEL_CAPABILITY: Record<string, number> = {
  "claude-sonnet-4-6": 85,
  "claude-opus-4": 90,
  "claude-opus-4-6": 90,
  "gpt-5": 88,
  "gpt-4o": 76,
  "deepseek-v3": 80,
  "deepseek-v3.2": 82,
  "qwen-3.6-plus": 78,
  "gemini-3-flash": 72,
  "gemini-3-pro": 80,
  "glm-5": 55,
};

const SELF_ORG_THRESHOLD = 70;

export function resolveCoordinationMode(
  companyMode: CoordinationMode,
  agentModels: string[],
): ResolvedCoordinationMode {
  if (companyMode === "structured") return "structured";
  if (companyMode === "sequential") return "sequential";

  // Auto mode: check all agent models against threshold
  const allCapable = agentModels.every((model) => {
    const normalized = normalizeModelName(model);
    const score = MODEL_CAPABILITY[normalized] ?? 50; // Unknown = conservative
    return score >= SELF_ORG_THRESHOLD;
  });

  return allCapable ? "sequential" : "structured";
}

function normalizeModelName(model: string): string {
  // Strip provider prefixes (e.g., "anthropic/claude-opus-4-6" → "claude-opus-4-6")
  const parts = model.split("/");
  return parts[parts.length - 1]!.toLowerCase();
}

// Extract model from agent's adapterConfig
export function extractModelFromAdapterConfig(
  adapterType: string,
  adapterConfig: Record<string, unknown>
): string {
  // Different adapters store model differently
  if (typeof adapterConfig.model === "string") return adapterConfig.model;
  if (typeof adapterConfig.modelId === "string") return adapterConfig.modelId;
  // Gateway adapters might have nested config
  if (typeof adapterConfig.modelConfig === "object" && adapterConfig.modelConfig) {
    const mc = adapterConfig.modelConfig as Record<string, unknown>;
    if (typeof mc.model === "string") return mc.model;
  }
  return "unknown";
}

export { MODEL_CAPABILITY, SELF_ORG_THRESHOLD };
```

---

#### D. `server/src/services/sequential-coordinator.ts` (~150 lines)

**Purpose:** Sequential advance logic, predecessor retrieval, and processing order generation.

```typescript
// server/src/services/sequential-coordinator.ts

import { eq, and, asc } from "drizzle-orm";
import { issues, issueComments, agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

export interface SequentialContribution {
  agentName: string;
  body: string;
  contributionType: string;
  claimedRole: string | null;
  createdAt: Date;
}

export async function advanceSequentialIssue(
  db: Db,
  heartbeat: IssueAssignmentWakeupDeps,
  issueId: string,
  companyId: string,
  completedAgentId: string,
  contributionType: "output" | "abstain",
  claimedRole: string | null,
): Promise<void> {
  // Implementation as per spec
}

export async function getPredecessorContributions(
  db: Db,
  issueId: string,
): Promise<SequentialContribution[]> {
  // Implementation as per spec
}

export async function generateProcessingOrder(
  db: Db,
  companyId: string,
): Promise<string[]> {
  // Get active agents ordered by createdAt
  const activeAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.status, "active")))
    .orderBy(asc(agents.createdAt));

  return activeAgents.map((a) => a.id);
}
```

---

#### E. `packages/db/src/migrations/0053_coordination_mode.sql` (~15 lines)

```sql
-- Company-level coordination mode
ALTER TABLE "companies"
  ADD COLUMN "coordination_mode" text NOT NULL DEFAULT 'structured';

-- Issue processing queue for sequential mode
ALTER TABLE "issues"
  ADD COLUMN "processing_order" jsonb,
  ADD COLUMN "processing_position" integer,
  ADD COLUMN "processing_started_at" timestamp with time zone;

-- Track sequential contributions per issue comment
ALTER TABLE "issue_comments"
  ADD COLUMN "contribution_type" text,
  ADD COLUMN "claimed_role" text;
```

---

### 1.2 Modified Files

#### A. `packages/db/src/schema/companies.ts`

**Add after `reviewMode` (line 21):**

```typescript
coordinationMode: text("coordination_mode").notNull().default("structured"),
```

---

#### B. `packages/db/src/schema/issues.ts`

**Add after `updatedAt` (line 59), before the table configuration:**

```typescript
processingOrder: jsonb("processing_order").$type<string[]>(),
processingPosition: integer("processing_position"),
processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
```

---

#### C. `packages/db/src/schema/issue_comments.ts`

**Add after `body` (line 14):**

```typescript
contributionType: text("contribution_type"),
claimedRole: text("claimed_role"),
```

---

#### D. `packages/shared/src/validators/company.ts`

**Add coordination mode to the schemas:**

```typescript
// Add this constant after REVIEW_MODES:
export const COORDINATION_MODES = ["structured", "sequential", "auto"] as const;
export type CoordinationMode = (typeof COORDINATION_MODES)[number];

// In updateCompanySchema (around line 26), add:
coordinationMode: z.enum(COORDINATION_MODES).optional(),
```

---

#### E. `packages/shared/src/validators/issue.ts`

**Extend `addIssueCommentSchema` (line 84):**

```typescript
export const addIssueCommentSchema = z.object({
  body: z.string().min(1),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  contributionType: z.enum(["output", "abstain", "role_claim"]).optional(),
  claimedRole: z.string().max(200).optional(),
});
```

---

#### F. `ui/src/components/OnboardingWizard.tsx`

**Location:** Lines 679-730 (Step 1 rendering block)

**Change:** When `step === 1 && !existingCompanyId`, render `OnboardingChat` instead of the company form.

**Import to add at top:**
```typescript
import { OnboardingChat } from "./OnboardingChat";
```

**Replace step 1 rendering (around line 679):**

```typescript
{step === 1 && !existingCompanyId && (
  <OnboardingChat
    onComplete={(companyId, companyPrefix) => {
      setCreatedCompanyId(companyId);
      setCreatedCompanyPrefix(companyPrefix);
      // Skip to step 4 (launch) since concierge provisioned everything
      setStep(4);
    }}
  />
)}
{step === 1 && existingCompanyId && (
  <div className="space-y-5">
    {/* Keep existing Step 1 form for "add to existing company" flow */}
    ...existing code...
  </div>
)}
```

**Critical note:** The existing Step 1 form at lines 679-730 must be preserved for the `existingCompanyId` case (adding agent to existing company). Only replace when `!existingCompanyId`.

---

#### G. `server/src/routes/onboarding.ts`

**Modify the provision endpoint (lines 83-95):**

```typescript
router.post("/:sessionId/provision", async (req, res) => {
  const userId = resolveUserId(req);
  const { companyName, coordinationMode } = req.body as {
    companyName?: unknown;
    coordinationMode?: unknown;
  };

  // Validate coordinationMode
  const validModes = ["structured", "sequential", "auto"];
  const mode = typeof coordinationMode === "string" && validModes.includes(coordinationMode)
    ? coordinationMode as "structured" | "sequential" | "auto"
    : undefined;

  const companyId = await concierge.provisionTeam(
    req.params.sessionId!,
    userId,
    portability.importBundle.bind(portability),
    typeof companyName === "string" && companyName.trim() ? companyName.trim() : undefined,
    mode, // New parameter
  );

  res.status(201).json({ companyId });
});
```

---

#### H. `server/src/services/onboarding/concierge.ts`

**Modify `provisionTeam` signature (line 336) and implementation:**

```typescript
async function provisionTeam(
  sessionId: string,
  userId: string,
  importBundle: ImportBundleFn,
  customCompanyName?: string,
  coordinationMode?: "structured" | "sequential" | "auto", // New parameter
): Promise<string> {
  // ... existing code until after importBundle succeeds (around line 391)

  const result = await importBundle(importInput, userId);

  // NEW: Set coordination mode on created company
  if (coordinationMode && coordinationMode !== "structured") {
    await db.update(companies)
      .set({ coordinationMode, updatedAt: new Date() })
      .where(eq(companies.id, result.company.id));
  }

  // ... rest of existing code
}
```

**Import to add at top:**
```typescript
import { companies } from "@paperclipai/db";
```

---

#### I. `server/src/services/issues.ts`

**Location:** Inside the `create` function, between lines 1047-1051 (before `tx.insert(issues)`)

**Add sequential processing order logic:**

```typescript
import { resolveCoordinationMode, extractModelFromAdapterConfig } from "./coordination-mode.js";
import { generateProcessingOrder } from "./sequential-coordinator.js";

// Inside create function, after building `values` but before insert:

// Resolve coordination mode and set processing order for sequential mode
const companyRow = await tx
  .select({ coordinationMode: companies.coordinationMode })
  .from(companies)
  .where(eq(companies.id, companyId))
  .then(rows => rows[0]);

if (companyRow && companyRow.coordinationMode !== "structured") {
  // Get agent models for auto-resolution
  const activeAgents = await tx
    .select({
      id: agents.id,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.status, "active")));

  const agentModels = activeAgents.map(a =>
    extractModelFromAdapterConfig(a.adapterType, a.adapterConfig as Record<string, unknown>)
  );

  const resolvedMode = resolveCoordinationMode(
    companyRow.coordinationMode as CoordinationMode,
    agentModels,
  );

  if (resolvedMode === "sequential" && activeAgents.length > 0) {
    const order = await generateProcessingOrder(tx, companyId);
    if (order.length > 0) {
      values.processingOrder = order;
      values.processingPosition = 0;
      values.processingStartedAt = new Date();
      values.assigneeAgentId = order[0]; // First agent in sequence
    }
  }
}
```

**Also extend `addComment` function (lines 1545-1576):**

```typescript
addComment: async (
  issueId: string,
  body: string,
  actor: { agentId?: string; userId?: string },
  options?: { contributionType?: string; claimedRole?: string } // New parameter
) => {
  // ... existing code ...

  const [comment] = await db
    .insert(issueComments)
    .values({
      companyId: issue.companyId,
      issueId,
      authorAgentId: actor.agentId ?? null,
      authorUserId: actor.userId ?? null,
      body: redactedBody,
      contributionType: options?.contributionType ?? null, // New field
      claimedRole: options?.claimedRole ?? null, // New field
    })
    .returning();

  // ... rest of existing code ...
}
```

---

#### J. `server/src/routes/issues.ts`

**Location:** Around line 1152-1156 where `svc.addComment` is called.

**Modify to pass contribution fields and trigger sequential advance:**

```typescript
if (commentBody) {
  // Extract contribution fields from request body
  const contributionType = req.body.contributionType as string | undefined;
  const claimedRole = req.body.claimedRole as string | undefined;

  comment = await svc.addComment(id, commentBody, {
    agentId: actor.agentId ?? undefined,
    userId: actor.actorType === "user" ? actor.actorId : undefined,
  }, { contributionType, claimedRole }); // Pass new options

  // Sequential advance after comment with contribution type
  if (contributionType && (contributionType === "output" || contributionType === "abstain")) {
    const issueRow = await db
      .select({
        processingOrder: issues.processingOrder,
        processingPosition: issues.processingPosition,
        companyId: issues.companyId,
      })
      .from(issues)
      .where(eq(issues.id, id))
      .limit(1)
      .then(r => r[0]);

    if (issueRow?.processingOrder) {
      const { advanceSequentialIssue } = await import("../services/sequential-coordinator.js");
      await advanceSequentialIssue(
        db, heartbeat, id, issueRow.companyId,
        actor.agentId!,
        contributionType as "output" | "abstain",
        claimedRole ?? null,
      );
    }
  }

  await logActivity(db, { /* existing activity log */ });
}
```

**Also ensure GET responses include new fields:**
- Issue GET: Include `processingOrder`, `processingPosition`, `processingStartedAt`
- Comments GET: Include `contributionType`, `claimedRole`

---

#### K. `server/src/routes/companies.ts`

**Location:** Lines 244-284 (PATCH endpoint)

**Ensure `coordinationMode` is accepted in updateCompanySchema.** The schema modification in `packages/shared/src/validators/company.ts` handles this automatically.

**Ensure GET response includes `coordinationMode`.** Check that the company select queries include this field (should be automatic from Drizzle schema).

---

#### L. `server/src/services/heartbeat.ts`

**Location:** This is a 4000+ line file. Find where the context snapshot is built for agent execution.

**Search for:** `contextSnapshot` construction or where the agent's prompt is built.

**Add sequential mode context injection:**

```typescript
import { getPredecessorContributions } from "./sequential-coordinator.js";

// In the context building section (likely around line 386 or where issue data is loaded):

if (issue.processingOrder && issue.processingPosition != null) {
  const predecessors = await getPredecessorContributions(db, issue.id);
  const order = issue.processingOrder as string[];
  const position = issue.processingPosition;

  // Add to context snapshot or prompt injection
  contextAdditions.sequentialInstruction =
    `You are agent ${position + 1} of ${order.length} processing this task sequentially. ` +
    `Review the task and all predecessor outputs below. Then:\n` +
    `(1) Choose a role that adds value given what predecessors have already done.\n` +
    `(2) If you cannot meaningfully contribute, ABSTAIN — post a comment with ` +
    `contributionType "abstain" and a brief reason.\n` +
    `(3) If you contribute, post a comment with contributionType "output", ` +
    `your claimed role, and your contribution.`;

  contextAdditions.predecessorOutputs = predecessors.map(p => ({
    agent: p.agentName,
    role: p.claimedRole ?? "unspecified",
    type: p.contributionType,
    output: p.body,
  }));
}
```

---

#### M. `ui/src/pages/CompanySettings.tsx`

**Location:** After the "Hiring" section (around line 393), add a "Team Coordination" section.

**Add state:**
```typescript
const [coordinationMode, setCoordinationMode] = useState("structured");

// In useEffect that syncs company data:
setCoordinationMode(selectedCompany.coordinationMode ?? "structured");
```

**Add section JSX (before "Invites"):**

```tsx
{/* Team Coordination */}
<div className="space-y-4">
  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
    Team Coordination
  </div>
  <div className="space-y-3 rounded-md border border-border px-4 py-4">
    <Field
      label="Coordination mode"
      hint="How agents collaborate on tasks."
    >
      <select
        value={coordinationMode}
        onChange={(e) => {
          setCoordinationMode(e.target.value);
          companiesApi.update(selectedCompanyId!, { coordinationMode: e.target.value });
        }}
        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
      >
        <option value="auto">Auto — platform picks based on model capabilities</option>
        <option value="sequential">Self-Organizing — agents pick their own roles (14% quality boost)</option>
        <option value="structured">Managed Team — fixed role assignments</option>
      </select>
    </Field>
  </div>
</div>
```

---

#### N. `ui/src/pages/IssueDetail.tsx`

**Add sequential progress indicator.** Find where issue metadata is displayed (likely near the top of the return statement).

**Add import:**
```typescript
import { Sparkles } from "lucide-react";
```

**Add progress bar component (in the issue header area):**

```tsx
{issue.processingOrder && (
  <div className="border rounded-lg p-4 mb-4">
    <div className="flex items-center gap-2 mb-2">
      <Sparkles className="h-4 w-4 text-amber-500" />
      <span className="text-sm font-medium">Self-Organizing Progress</span>
      <span className="text-xs text-muted-foreground ml-auto">
        Agent {Math.min((issue.processingPosition ?? 0) + 1, issue.processingOrder.length)}/{issue.processingOrder.length}
      </span>
    </div>
    <div className="flex gap-1">
      {(issue.processingOrder as string[]).map((agentId, i) => (
        <div
          key={agentId}
          className={cn(
            "h-2 flex-1 rounded-full",
            i < (issue.processingPosition ?? 0) ? "bg-green-500" :
            i === (issue.processingPosition ?? 0) ? "bg-amber-500 animate-pulse" :
            "bg-muted"
          )}
        />
      ))}
    </div>
  </div>
)}
```

**In comment rendering, add contribution badges:**

```tsx
{comment.contributionType === "abstain" && (
  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Abstained</span>
)}
{comment.claimedRole && (
  <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">{comment.claimedRole}</span>
)}
```

---

## 2. Implementation Order

Execute in this order (dependencies first):

1. **Migration** - `0053_coordination_mode.sql`
2. **Drizzle schemas** - `companies.ts`, `issues.ts`, `issue_comments.ts`
3. **Shared validators** - `company.ts`, `issue.ts`
4. **New services** - `coordination-mode.ts`, `sequential-coordinator.ts`
5. **API client** - `ui/src/api/onboarding.ts`
6. **Backend routes/services modifications:**
   - `server/src/services/onboarding/concierge.ts`
   - `server/src/routes/onboarding.ts`
   - `server/src/services/issues.ts`
   - `server/src/routes/issues.ts`
   - `server/src/routes/companies.ts`
   - `server/src/services/heartbeat.ts`
7. **UI components:**
   - `OnboardingChat.tsx`
   - `OnboardingWizard.tsx` modifications
   - `CompanySettings.tsx` modifications
   - `IssueDetail.tsx` modifications

---

## 3. Gotchas and Edge Cases

### 3.1 API Client Pattern
The UI uses `api.post(path, body)` NOT `apiClient.post`. Check `ui/src/api/client.ts`:
- Methods: `api.get`, `api.post`, `api.patch`, `api.put`, `api.delete`
- POST requires body argument: `api.post<T>(path, body)`
- GET has no body: `api.get<T>(path)`

### 3.2 OnboardingWizard `existingCompanyId` Detection
Line 104 of `OnboardingWizard.tsx`:
```typescript
const existingCompanyId = effectiveOnboardingOptions.companyId;
```
This comes from `onboardingOptions` passed via `useDialog()`. When user clicks "Create another company", `existingCompanyId` is `undefined`. When adding an agent to existing company, it's set.

**Key:** Only show `OnboardingChat` when `step === 1 && !existingCompanyId`.

### 3.3 Agents Table Model Storage
The `agents` table stores adapter config in `adapterConfig` (JSONB). Model is typically:
- `adapterConfig.model` for most adapters
- Some gateway adapters may nest it differently

The `extractModelFromAdapterConfig` function handles this.

### 3.4 Heartbeat Service Context Injection
The `heartbeat.ts` file is 4000+ lines. Key areas to find:
- Search for `contextSnapshot` usage
- Search for `buildPrompt` or similar
- Look for where issue context is loaded before agent invocation
- The sequential instruction should be added to whatever context object gets sent to the agent

### 3.5 `addComment` Service Signature Extension
Current signature (line 1545):
```typescript
addComment: async (issueId: string, body: string, actor: { agentId?: string; userId?: string })
```
Must extend to accept optional `options: { contributionType?: string; claimedRole?: string }`.

**All existing callers pass only 3 args, so the 4th arg with `?` is backward-compatible.**

### 3.6 Sequential Advance Only When processingOrder Exists
Never call `advanceSequentialIssue` unless `issue.processingOrder` is non-null. Structured-mode issues have `processingOrder = null`.

### 3.7 N+1 Query Prevention
In `sequential-coordinator.ts`, the `getPredecessorContributions` function joins `issueComments` with `agents` in a single query. Do NOT loop through comments and query agent name individually.

### 3.8 Transaction Scope for Issue Creation
The sequential processing order logic must run inside the same transaction as the issue insert (`tx` not `db`). See lines 931-1057 in `issues.ts`.

### 3.9 PostgreSQL JSONB Type
Migration uses `jsonb` for `processing_order`, not `json`. Drizzle schema uses `jsonb("processing_order").$type<string[]>()`.

---

## 4. Review Checklist

@review must verify each item:

### 4.1 TypeScript Correctness
- [ ] No `any` casts without documented justification
- [ ] All new interfaces properly exported
- [ ] Function signatures match between service and route layers
- [ ] Optional parameters use `?` syntax, not `| undefined`

### 4.2 Drizzle Schema
- [ ] All new columns use `pgTable` (not `sqliteTable`)
- [ ] JSONB columns use `.$type<T>()` for proper typing
- [ ] Timestamps include `{ withTimezone: true }`
- [ ] Default values match migration SQL

### 4.3 SQL Migration
- [ ] Migration file is `0053_coordination_mode.sql` (next sequence number)
- [ ] Uses `ALTER TABLE` with proper PostgreSQL syntax
- [ ] Default value matches Drizzle schema default
- [ ] Column names use snake_case matching existing convention

### 4.4 OnboardingChat Component
- [ ] Calls `onboardingApi.start()` on mount
- [ ] Handles loading state (disables input, shows indicator)
- [ ] Handles error state (displays inline error, allows retry)
- [ ] Auto-scrolls to bottom on new messages
- [ ] Shows recommendation card only after `isComplete === true`
- [ ] Coordination mode selector prominent (not hidden in advanced settings)
- [ ] "Auto" is pre-selected as default coordination mode
- [ ] Passes `coordinationMode` to provision call

### 4.5 Coordination Mode Flow
- [ ] `coordinationMode` passed from UI → route → service → company update
- [ ] Default is "structured" for new companies
- [ ] "auto" mode correctly resolves based on agent models
- [ ] Unknown models default to score 50 (conservative)

### 4.6 Sequential Processing
- [ ] `generateProcessingOrder` returns agents ordered by `createdAt`
- [ ] First agent in order gets assigned on issue creation
- [ ] `advanceSequentialIssue` increments position and reassigns
- [ ] Last agent completion sets issue status to "done"
- [ ] Abstention still advances to next agent
- [ ] Wakeup includes sequential context (`position`, `predecessorCount`)

### 4.7 No N+1 Queries
- [ ] `getPredecessorContributions` uses single JOIN query
- [ ] Issue creation coordination logic batches agent queries
- [ ] No loops with individual DB queries inside

### 4.8 Tests
- [ ] Unit tests for `resolveCoordinationMode` cover all modes
- [ ] Unit tests for `advanceSequentialIssue` cover completion/abstention
- [ ] Integration tests verify full provision → create issue → sequential flow
- [ ] OnboardingChat tests mock API calls appropriately

### 4.9 No Hardcoded Data
- [ ] No mock data in production code
- [ ] Model capability scores are in a const object, not inline
- [ ] Template keys reference `ONBOARDING_TEMPLATES` not hardcoded strings

### 4.10 Backward Compatibility
- [ ] Existing companies unaffected (default `coordinationMode = "structured"`)
- [ ] Existing issues unaffected (`processingOrder = null`)
- [ ] Existing comments unaffected (`contributionType = null`)
- [ ] Existing API responses gain optional fields (non-breaking)

---

## 5. Test Architecture

### 5.1 `server/src/services/__tests__/coordination-mode.test.ts`

```typescript
describe("resolveCoordinationMode", () => {
  it("returns 'structured' when company mode is 'structured'", () => {
    expect(resolveCoordinationMode("structured", ["claude-opus-4-6"])).toBe("structured");
  });

  it("returns 'sequential' when company mode is 'sequential'", () => {
    expect(resolveCoordinationMode("sequential", ["glm-5"])).toBe("sequential");
  });

  it("returns 'sequential' when auto + all agents above threshold", () => {
    expect(resolveCoordinationMode("auto", ["claude-opus-4-6", "gpt-5"])).toBe("sequential");
  });

  it("returns 'structured' when auto + any agent below threshold", () => {
    expect(resolveCoordinationMode("auto", ["claude-opus-4-6", "glm-5"])).toBe("structured");
  });

  it("returns 'structured' when auto + unknown model (conservative)", () => {
    expect(resolveCoordinationMode("auto", ["unknown-model-xyz"])).toBe("structured");
  });

  it("normalizes model names with provider prefixes", () => {
    expect(resolveCoordinationMode("auto", ["anthropic/claude-opus-4-6"])).toBe("sequential");
  });
});

describe("extractModelFromAdapterConfig", () => {
  it("extracts model from top-level model field", () => {
    expect(extractModelFromAdapterConfig("claude_local", { model: "claude-opus-4-6" }))
      .toBe("claude-opus-4-6");
  });

  it("returns 'unknown' when no model field present", () => {
    expect(extractModelFromAdapterConfig("http", {})).toBe("unknown");
  });
});
```

### 5.2 `server/src/services/__tests__/sequential-coordinator.test.ts`

```typescript
describe("advanceSequentialIssue", () => {
  // Mock db and heartbeat
  let mockDb: MockDb;
  let mockHeartbeat: jest.Mocked<IssueAssignmentWakeupDeps>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockHeartbeat = { wakeup: jest.fn().mockResolvedValue(undefined) };
  });

  it("advances processingPosition by 1 after agent output", async () => {
    mockDb.setIssue({ processingOrder: ["a1", "a2", "a3"], processingPosition: 0 });
    await advanceSequentialIssue(mockDb, mockHeartbeat, "issue1", "company1", "a1", "output", "Reviewer");
    expect(mockDb.getIssue("issue1").processingPosition).toBe(1);
  });

  it("updates assigneeAgentId to next agent in sequence", async () => {
    mockDb.setIssue({ processingOrder: ["a1", "a2", "a3"], processingPosition: 0 });
    await advanceSequentialIssue(mockDb, mockHeartbeat, "issue1", "company1", "a1", "output", null);
    expect(mockDb.getIssue("issue1").assigneeAgentId).toBe("a2");
  });

  it("wakes next agent with sequential context", async () => {
    mockDb.setIssue({ processingOrder: ["a1", "a2"], processingPosition: 0 });
    await advanceSequentialIssue(mockDb, mockHeartbeat, "issue1", "company1", "a1", "output", null);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith("a2", expect.objectContaining({
      payload: expect.objectContaining({ coordinationMode: "sequential", position: 1 }),
    }));
  });

  it("marks issue done when last agent completes", async () => {
    mockDb.setIssue({ processingOrder: ["a1", "a2"], processingPosition: 1 });
    await advanceSequentialIssue(mockDb, mockHeartbeat, "issue1", "company1", "a2", "output", null);
    expect(mockDb.getIssue("issue1").status).toBe("done");
  });

  it("no-ops if issue has no processingOrder", async () => {
    mockDb.setIssue({ processingOrder: null, processingPosition: null });
    await advanceSequentialIssue(mockDb, mockHeartbeat, "issue1", "company1", "a1", "output", null);
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });
});

describe("getPredecessorContributions", () => {
  it("returns all comments with non-null contributionType, ordered by createdAt", async () => {
    // Setup mock data
    const contributions = await getPredecessorContributions(mockDb, "issue1");
    expect(contributions).toHaveLength(2);
    expect(contributions[0].createdAt.getTime()).toBeLessThan(contributions[1].createdAt.getTime());
  });

  it("includes agent name, body, contributionType, claimedRole", async () => {
    const contributions = await getPredecessorContributions(mockDb, "issue1");
    expect(contributions[0]).toMatchObject({
      agentName: expect.any(String),
      body: expect.any(String),
      contributionType: expect.any(String),
      claimedRole: expect.any(String),
    });
  });
});

describe("generateProcessingOrder", () => {
  it("returns active agent IDs ordered by createdAt", async () => {
    const order = await generateProcessingOrder(mockDb, "company1");
    expect(order).toEqual(["agent1", "agent2", "agent3"]); // Ordered by createdAt
  });

  it("excludes inactive agents", async () => {
    const order = await generateProcessingOrder(mockDb, "company1");
    expect(order).not.toContain("inactiveAgent");
  });
});
```

### 5.3 `ui/src/components/__tests__/OnboardingChat.test.tsx`

```typescript
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { OnboardingChat } from "../OnboardingChat";
import { onboardingApi } from "../../api/onboarding";

jest.mock("../../api/onboarding");

describe("OnboardingChat", () => {
  const mockOnComplete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (onboardingApi.start as jest.Mock).mockResolvedValue({ sessionId: "session-1" });
  });

  it("calls onboardingApi.start() on mount", async () => {
    render(<OnboardingChat onComplete={mockOnComplete} />);
    await waitFor(() => {
      expect(onboardingApi.start).toHaveBeenCalled();
    });
  });

  it("displays initial greeting message", async () => {
    render(<OnboardingChat onComplete={mockOnComplete} />);
    await waitFor(() => {
      expect(screen.getByText(/Welcome to Autogeny/i)).toBeInTheDocument();
    });
  });

  it("sends user message via onboardingApi.sendMessage()", async () => {
    (onboardingApi.sendMessage as jest.Mock).mockResolvedValue({
      response: "Great choice!",
      stage: "goals",
      isComplete: false,
    });

    render(<OnboardingChat onComplete={mockOnComplete} />);
    await waitFor(() => expect(onboardingApi.start).toHaveBeenCalled());

    const input = screen.getByPlaceholderText(/type a message/i);
    fireEvent.change(input, { target: { value: "I run a SaaS startup" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(onboardingApi.sendMessage).toHaveBeenCalledWith("session-1", "I run a SaaS startup");
    });
  });

  it("shows recommendation card when isComplete=true", async () => {
    (onboardingApi.sendMessage as jest.Mock).mockResolvedValue({
      response: "Here's my recommendation...",
      stage: "complete",
      isComplete: true,
    });

    render(<OnboardingChat onComplete={mockOnComplete} />);
    await waitFor(() => expect(onboardingApi.start).toHaveBeenCalled());

    // Trigger message that completes discovery
    const input = screen.getByPlaceholderText(/type a message/i);
    fireEvent.change(input, { target: { value: "third message" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText(/Team Coordination/i)).toBeInTheDocument();
    });
  });

  it("'Auto' is pre-selected as default coordination mode", async () => {
    // Setup complete state
    (onboardingApi.sendMessage as jest.Mock).mockResolvedValue({
      response: "Done!",
      stage: "complete",
      isComplete: true,
    });

    render(<OnboardingChat onComplete={mockOnComplete} />);
    // ... trigger completion ...

    await waitFor(() => {
      const autoRadio = screen.getByLabelText(/Auto.*Recommended/i);
      expect(autoRadio).toBeChecked();
    });
  });

  it("calls onboardingApi.provision() with coordinationMode on 'Set up my team'", async () => {
    (onboardingApi.provision as jest.Mock).mockResolvedValue({ companyId: "company-1" });
    // ... setup complete state ...

    fireEvent.click(screen.getByText(/Set up my team/i));

    await waitFor(() => {
      expect(onboardingApi.provision).toHaveBeenCalledWith(
        "session-1",
        expect.any(String),
        "auto" // default mode
      );
    });
  });

  it("disables input while waiting for API response", async () => {
    (onboardingApi.sendMessage as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 1000))
    );

    render(<OnboardingChat onComplete={mockOnComplete} />);
    await waitFor(() => expect(onboardingApi.start).toHaveBeenCalled());

    const input = screen.getByPlaceholderText(/type a message/i);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(input).toBeDisabled();
  });
});
```

### 5.4 Integration Tests

```typescript
describe("concierge + self-org e2e", () => {
  it("new user → OnboardingChat → 3 exchanges → recommendation shown", async () => {
    // Test full chat flow
  });

  it("provision with coordinationMode='sequential' → company.coordinationMode === 'sequential'", async () => {
    // Verify company creation with mode
  });

  it("create issue in sequential company → processingOrder populated", async () => {
    // Verify sequential fields set
  });

  it("first agent wakes, posts output → advances to second agent", async () => {
    // Verify position increment and reassignment
  });

  it("second agent sees predecessor output in context", async () => {
    // Verify context injection
  });

  it("agent abstains → advances without contribution", async () => {
    // Verify abstention handling
  });

  it("last agent completes → issue status 'done'", async () => {
    // Verify completion
  });

  it("company coordinationMode='auto' + strong models → resolves to sequential", async () => {
    // Verify auto resolution
  });

  it("company coordinationMode='auto' + weak models → resolves to structured", async () => {
    // Verify conservative auto
  });

  it("switch mode in company settings → new issues use new mode", async () => {
    // Verify settings persistence
  });
});
```

---

## Summary

This plan covers all aspects of Task 14:

1. **5 new files** for API client, chat UI, coordination services, and migration
2. **14 modified files** across backend services/routes, frontend components, and schemas
3. **Clear implementation order** respecting dependencies
4. **Detailed gotchas** based on actual code patterns discovered
5. **Comprehensive review checklist** for @review
6. **Test architecture** with specific test cases

The implementation should take ~8 hours as estimated, with the majority of complexity in the heartbeat context injection and ensuring the OnboardingWizard modification preserves existing "add agent to company" flows.
