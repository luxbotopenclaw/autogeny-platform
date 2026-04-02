# Task 14: Onboarding Concierge UI + Self-Organizing Mode — Architecture Plan

**Author:** @plan agent
**Date:** 2026-04-02
**For:** @lead (Forge)

---

## 1. Architecture Plan

### 1.1 New Files

#### `ui/src/api/onboarding.ts` (~60 lines)

**Purpose:** API client for onboarding concierge endpoints.

```typescript
// Types
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
  companyPrefix: string;  // ADD THIS - needed for routing after provision
}

// Export object
export const onboardingApi = {
  start: () => api.post<OnboardingStartResponse>("/onboarding/start", {}),
  sendMessage: (sessionId: string, message: string) =>
    api.post<OnboardingMessageResponse>(`/onboarding/${sessionId}/message`, { message }),
  getSession: (sessionId: string) =>
    api.get<OnboardingSessionResponse>(`/onboarding/${sessionId}`),
  provision: (sessionId: string, companyName?: string, coordinationMode?: string) =>
    api.post<OnboardingProvisionResponse>(`/onboarding/${sessionId}/provision`, {
      companyName,
      coordinationMode
    }),
};
```

**Integration:** Import from `./client.js` and use `api.post(path, body)` pattern (not `apiClient.post`).

---

#### `ui/src/components/OnboardingChat.tsx` (~400 lines)

**Purpose:** Chat-based onboarding UI that replaces Step 1 of the wizard for new users.

**Component interface:**
```typescript
interface OnboardingChatProps {
  onComplete: (companyId: string, companyPrefix: string) => void;
}
```

**State:**
```typescript
const [sessionId, setSessionId] = useState<string | null>(null);
const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
const [inputValue, setInputValue] = useState("");
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
const [stage, setStage] = useState<string>("greeting");
const [isComplete, setIsComplete] = useState(false);
const [recommendation, setRecommendation] = useState<OnboardingSessionResponse["recommendationData"] | null>(null);
const [coordinationMode, setCoordinationMode] = useState<"auto" | "sequential" | "structured">("auto");
const [companyName, setCompanyName] = useState("");
const [isProvisioning, setIsProvisioning] = useState(false);
const messagesEndRef = useRef<HTMLDivElement>(null);
```

**Effects:**
1. On mount: call `onboardingApi.start()` → store sessionId, fetch session state if exists
2. On messages change: scroll to bottom using `messagesEndRef.current?.scrollIntoView()`
3. On recommendation received: pre-fill `companyName` from `recommendation.companyName`

**Message flow:**
1. User submits message → set `isLoading=true`, disable input
2. Call `onboardingApi.sendMessage(sessionId, message)`
3. On success: append both user and assistant messages, update stage
4. If `isComplete=true`: fetch full session via `onboardingApi.getSession(sessionId)` to get recommendation data
5. On error: set error state, allow retry

**Provision flow:**
1. User clicks "Set up my team" → set `isProvisioning=true`
2. Call `onboardingApi.provision(sessionId, companyName.trim() || undefined, coordinationMode)`
3. On success: call `onComplete(companyId, companyPrefix)`

**Layout structure:**
```
┌─────────────────────────────────────────────────────────────┐
│  ← Close                    Stage indicator (greeting/...)  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [Assistant message bubble - bg-muted]                     │
│                                                             │
│                    [User message bubble - bg-primary]       │
│                                                             │
│  ... more messages ...                                      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ RECOMMENDATION CARD (when isComplete)               │   │
│  │ - Template name & description                       │   │
│  │ - Agent list with runtime badges                    │   │
│  │ - COORDINATION MODE SELECTOR (prominent!)           │   │
│  │ - Editable company name                             │   │
│  │ - "Set up my team" button                           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ [Input field ___________________________] [Send button]     │
└─────────────────────────────────────────────────────────────┘
```

**Styling notes:**
- Use existing `cn()` utility from `../lib/utils`
- Chat bubbles: assistant = `bg-muted rounded-lg p-3`, user = `bg-primary text-primary-foreground rounded-lg p-3`
- Use `Sparkles` icon from lucide-react for coordination mode section
- Use `Loader2` with `animate-spin` for loading states

---

#### `server/src/services/coordination-mode.ts` (~120 lines)

**Purpose:** Resolve effective coordination mode + model capability registry.

```typescript
export const MODEL_CAPABILITY: Record<string, number> = {
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

export const SELF_ORG_THRESHOLD = 70;
export type CoordinationMode = "structured" | "sequential" | "auto";
export type ResolvedCoordinationMode = "structured" | "sequential";

export function resolveCoordinationMode(
  companyMode: CoordinationMode,
  agentModels: string[],
): ResolvedCoordinationMode;

export function normalizeModelName(model: string): string;
```

**normalizeModelName implementation:**
- Strip provider prefixes: `"anthropic/claude-opus-4-6"` → `"claude-opus-4-6"`
- Lowercase the result

---

#### `server/src/services/sequential-coordinator.ts` (~200 lines)

**Purpose:** Sequential advance logic + predecessor retrieval.

```typescript
import { eq, and } from "drizzle-orm";
import { issues, issueComments, agents, companies } from "@paperclipai/db";
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
): Promise<void>;

export async function getPredecessorContributions(
  db: Db,
  issueId: string,
): Promise<SequentialContribution[]>;

export async function generateProcessingOrder(
  db: Db,
  companyId: string,
): Promise<string[]>;
```

---

#### `packages/db/src/migrations/0053_coordination_mode.sql` (~15 lines)

```sql
-- Company-level coordination mode
ALTER TABLE companies
  ADD COLUMN coordination_mode text NOT NULL DEFAULT 'structured';

-- Issue processing queue for sequential mode
ALTER TABLE issues
  ADD COLUMN processing_order jsonb,
  ADD COLUMN processing_position integer,
  ADD COLUMN processing_started_at timestamptz;

-- Track sequential contributions per issue
ALTER TABLE issue_comments
  ADD COLUMN contribution_type text,
  ADD COLUMN claimed_role text;
```

**Note:** The platform uses PostgreSQL (confirmed by `pgTable` in all schema files).

---

### 1.2 Modified Files

#### `packages/db/src/schema/companies.ts`

**Add after line 21 (after `reviewMode`):**
```typescript
coordinationMode: text("coordination_mode").notNull().default("structured"),
```

---

#### `packages/db/src/schema/issues.ts`

**Add after line 58 (after `updatedAt`):**
```typescript
processingOrder: jsonb("processing_order").$type<string[]>(),
processingPosition: integer("processing_position"),
processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
```

---

#### `packages/db/src/schema/issue_comments.ts`

**Add after line 14 (after `body`):**
```typescript
contributionType: text("contribution_type"),
claimedRole: text("claimed_role"),
```

---

#### `packages/shared/src/validators/company.ts`

**Add new constant and update schema:**
```typescript
export const COORDINATION_MODES = ["structured", "sequential", "auto"] as const;
export type CoordinationMode = (typeof COORDINATION_MODES)[number];

// Update updateCompanySchema to include:
coordinationMode: z.enum(COORDINATION_MODES).optional(),
```

---

#### `packages/shared/src/validators/issue.ts`

**Update `addIssueCommentSchema` (lines 84-88):**
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

#### `ui/src/components/OnboardingWizard.tsx`

**Key changes:**

1. **Import OnboardingChat** (at top with other imports):
```typescript
import { OnboardingChat } from "./OnboardingChat";
```

2. **Replace Step 1 rendering (around line 679):**

Current structure at line 679:
```tsx
{step === 1 && (
  <div className="space-y-5">
    ...
```

Replace with:
```tsx
{step === 1 && !existingCompanyId && (
  <OnboardingChat
    onComplete={(companyId, companyPrefix) => {
      setCreatedCompanyId(companyId);
      setCreatedCompanyPrefix(companyPrefix);
      setSelectedCompanyId(companyId);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // Skip to step 4 (launch) since concierge provisioned everything
      setStep(4);
    }}
  />
)}
{step === 1 && existingCompanyId && (
  <div className="space-y-5">
    {/* Original Step 1 content for "add to existing company" flow */}
    ...
```

**Important:** The `existingCompanyId` check (line 104) is already available from `effectiveOnboardingOptions.companyId`. When undefined/null, show OnboardingChat. When set, show original Step 1 form.

---

#### `server/src/routes/onboarding.ts`

**Update provision endpoint (lines 83-95):**
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

  const result = await concierge.provisionTeam(
    req.params.sessionId!,
    userId,
    portability.importBundle.bind(portability),
    typeof companyName === "string" && companyName.trim() ? companyName.trim() : undefined,
    mode,
  );

  res.status(201).json(result);
});
```

**Also update return type:** The provision endpoint should return `{ companyId, companyPrefix }` so the UI can route properly.

---

#### `server/src/services/onboarding/concierge.ts`

**Update `provisionTeam` function signature and implementation (around line 336):**

1. Add coordinationMode parameter:
```typescript
async function provisionTeam(
  sessionId: string,
  userId: string,
  importBundle: ImportBundleFn,
  customCompanyName?: string,
  coordinationMode?: "structured" | "sequential" | "auto",
): Promise<{ companyId: string; companyPrefix: string }> {
```

2. After `importBundle` succeeds (around line 391), add:
```typescript
const result = await importBundle(importInput, userId);

// Set coordinationMode if provided and not default
if (coordinationMode && coordinationMode !== "structured") {
  await db.update(companies)
    .set({ coordinationMode, updatedAt: new Date() })
    .where(eq(companies.id, result.company.id));
}

// ... rest of existing code ...

return { companyId: result.company.id, companyPrefix: result.company.issuePrefix };
```

3. Add import at top:
```typescript
import { companies } from "@paperclipai/db";
```

---

#### `server/src/services/issues.ts`

**Update the `create` function (lines 908-1058):**

1. Add imports at top:
```typescript
import { resolveCoordinationMode } from "./coordination-mode.js";
import { generateProcessingOrder } from "./sequential-coordinator.js";
```

2. Inside the transaction, after building `values` (around line 1040) but before the insert (line 1051), add:
```typescript
// Resolve coordination mode for sequential processing
const [companyRow] = await tx
  .select({ coordinationMode: companies.coordinationMode })
  .from(companies)
  .where(eq(companies.id, companyId));

if (companyRow && companyRow.coordinationMode !== "structured") {
  // Get active agent models from adapterConfig
  const activeAgents = await tx
    .select({
      id: agents.id,
      adapterConfig: agents.adapterConfig
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.status, "active")));

  const agentModels = activeAgents.map(a => {
    const config = a.adapterConfig as Record<string, unknown> | null;
    return (config?.model as string) ?? "unknown";
  });

  const resolvedMode = resolveCoordinationMode(
    companyRow.coordinationMode as "structured" | "sequential" | "auto",
    agentModels,
  );

  if (resolvedMode === "sequential") {
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

---

#### `server/src/routes/issues.ts`

**Update the PATCH endpoint to handle sequential advance after comment (around line 1152-1160):**

After `comment = await svc.addComment(...)`:
```typescript
let comment = null;
if (commentBody) {
  // Parse contribution fields from body
  const { contributionType: contribType, claimedRole: claimedRoleVal } = req.body as {
    contributionType?: string;
    claimedRole?: string;
  };

  comment = await svc.addComment(id, commentBody, {
    agentId: actor.agentId ?? undefined,
    userId: actor.actorType === "user" ? actor.actorId : undefined,
    contributionType: contribType,
    claimedRole: claimedRoleVal,
  });

  // If sequential mode and contribution complete, advance the queue
  if (contribType && (contribType === "output" || contribType === "abstain")) {
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
        db,
        heartbeat,
        id,
        issueRow.companyId,
        actor.agentId!,
        contribType as "output" | "abstain",
        claimedRoleVal ?? null,
      );
    }
  }
  // ... rest of existing logging ...
```

**Also update the GET issue endpoint** to include new fields in response (the select should already include them via `*` or needs explicit addition).

**Also update GET comments endpoint** to include `contributionType` and `claimedRole`.

---

#### `server/src/services/issues.ts` — `addComment` function

**Update the `addComment` function (lines 1545-1576):**

```typescript
addComment: async (
  issueId: string,
  body: string,
  actor: {
    agentId?: string;
    userId?: string;
    contributionType?: string;
    claimedRole?: string;
  }
) => {
  // ... existing validation ...

  const [comment] = await db
    .insert(issueComments)
    .values({
      companyId: issue.companyId,
      issueId,
      authorAgentId: actor.agentId ?? null,
      authorUserId: actor.userId ?? null,
      body: redactedBody,
      contributionType: actor.contributionType ?? null,
      claimedRole: actor.claimedRole ?? null,
    })
    .returning();

  // ... rest unchanged ...
```

---

#### `server/src/routes/companies.ts`

**Update PATCH endpoint (around line 264):**

The `updateCompanySchema` already parses the body. Just ensure `coordinationMode` is included in the schema update (see `packages/shared/src/validators/company.ts` modification above).

**Update GET endpoint** to include `coordinationMode` in response (should be automatic if selecting all fields).

---

#### `ui/src/pages/CompanySettings.tsx`

**Add coordination mode section (~50 lines of changes):**

1. Add state (around line 39):
```typescript
const [coordinationMode, setCoordinationMode] = useState<string>("structured");
```

2. Sync from company (in useEffect around line 43-48):
```typescript
setCoordinationMode(selectedCompany.coordinationMode ?? "structured");
```

3. Update generalDirty check:
```typescript
const generalDirty =
  !!selectedCompany &&
  (companyName !== selectedCompany.name ||
    description !== (selectedCompany.description ?? "") ||
    brandColor !== (selectedCompany.brandColor ?? "") ||
    coordinationMode !== (selectedCompany.coordinationMode ?? "structured"));
```

4. Include in save mutation (handleSaveGeneral):
```typescript
generalMutation.mutate({
  name: companyName.trim(),
  description: description.trim() || null,
  brandColor: brandColor || null,
  coordinationMode: coordinationMode as "structured" | "sequential" | "auto",
});
```

5. Add UI section after company name field, before brandColor (around line 243):
```tsx
<Field
  label="Team Coordination Mode"
  hint="Controls how agents collaborate on tasks."
>
  <select
    value={coordinationMode}
    onChange={(e) => setCoordinationMode(e.target.value)}
    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
  >
    <option value="auto">Auto — platform picks based on model capabilities</option>
    <option value="sequential">Self-Organizing — agents pick their own roles (research-backed, 14% quality boost)</option>
    <option value="structured">Managed Team — fixed role assignments</option>
  </select>
</Field>
```

---

#### `ui/src/pages/IssueDetail.tsx`

**Add sequential progress display (~40 lines of changes):**

1. After imports, add Sparkles icon if not present
2. In the issue detail render, add progress bar when `issue.processingOrder` exists:

```tsx
{issue.processingOrder && Array.isArray(issue.processingOrder) && (
  <div className="border border-border rounded-lg p-4 mb-4">
    <div className="flex items-center gap-2 mb-2">
      <Sparkles className="h-4 w-4 text-amber-500" />
      <span className="text-sm font-medium">Self-Organizing Progress</span>
      <span className="text-xs text-muted-foreground ml-auto">
        Agent {Math.min((issue.processingPosition ?? 0) + 1, issue.processingOrder.length)}/{issue.processingOrder.length}
      </span>
    </div>
    <div className="flex gap-1">
      {issue.processingOrder.map((agentId: string, i: number) => (
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

3. In comment rendering, add contribution badges:
```tsx
{comment.contributionType === "abstain" && (
  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground ml-2">
    Abstained
  </span>
)}
{comment.claimedRole && (
  <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary ml-2">
    {comment.claimedRole}
  </span>
)}
```

---

#### `server/src/services/heartbeat.ts`

**Add sequential mode context injection (~30 lines):**

Find where context is built for agent invocation (around the `contextSnapshot` handling, lines 380-410 area). Add:

```typescript
import { getPredecessorContributions } from "./sequential-coordinator.js";

// In the context building section, after loading the issue:
if (issue && issue.processingOrder && issue.processingPosition != null) {
  const predecessors = await getPredecessorContributions(db, issue.id);
  const order = issue.processingOrder as string[];
  const position = issue.processingPosition;

  context.sequentialInstruction =
    `You are agent ${position + 1} of ${order.length} processing this task sequentially. ` +
    `Review the task and all predecessor outputs below. Then:\n` +
    `(1) Choose a role that adds value given what predecessors have already done.\n` +
    `(2) If you cannot meaningfully contribute beyond what predecessors have done, ABSTAIN — ` +
    `post a comment with contributionType "abstain" and a brief reason.\n` +
    `(3) If you contribute, post a comment with contributionType "output", ` +
    `your claimed role, and your contribution.`;

  context.predecessorOutputs = predecessors.map(p => ({
    agent: p.agentName,
    role: p.claimedRole ?? "unspecified",
    type: p.contributionType,
    output: p.body,
  }));
}
```

**Note:** The exact injection point depends on how heartbeat.ts structures the agent prompt. Search for where `contextSnapshot` is merged into what gets sent to the agent. The sequential instructions should appear alongside (not replace) normal issue context.

---

## 2. Implementation Order

1. **Migration first:** `packages/db/src/migrations/0053_coordination_mode.sql`
2. **Schema updates:**
   - `packages/db/src/schema/companies.ts`
   - `packages/db/src/schema/issues.ts`
   - `packages/db/src/schema/issue_comments.ts`
3. **Validators:** `packages/shared/src/validators/company.ts`, `packages/shared/src/validators/issue.ts`
4. **New backend services:**
   - `server/src/services/coordination-mode.ts`
   - `server/src/services/sequential-coordinator.ts`
5. **Backend route/service modifications:**
   - `server/src/services/onboarding/concierge.ts`
   - `server/src/routes/onboarding.ts`
   - `server/src/services/issues.ts` (create function + addComment)
   - `server/src/routes/issues.ts`
   - `server/src/routes/companies.ts`
   - `server/src/services/heartbeat.ts`
6. **New frontend:**
   - `ui/src/api/onboarding.ts`
   - `ui/src/components/OnboardingChat.tsx`
7. **Frontend modifications:**
   - `ui/src/components/OnboardingWizard.tsx`
   - `ui/src/pages/CompanySettings.tsx`
   - `ui/src/pages/IssueDetail.tsx`
8. **Tests** (see Section 5)

---

## 3. Gotchas and Edge Cases

### API Client Pattern
- The UI uses `api.post(path, body)` NOT `apiClient.post(path, body)`
- Import from `./client.js`: `import { api } from "./client.js";`
- POST with empty body still needs `{}`: `api.post("/onboarding/start", {})`

### Wizard's existingCompanyId Detection
- Line 104: `const existingCompanyId = effectiveOnboardingOptions.companyId;`
- This comes from `effectiveOnboardingOptions` which merges `onboardingOptions` with `routeOnboardingOptions`
- When null/undefined → show OnboardingChat (new user flow)
- When set → show original Step 1 form (add-agent-to-existing flow)

### Agent Model Storage
- Model is stored in `agents.adapterConfig.model` (JSONB field)
- Not all adapters have model (e.g., http adapter)
- Default to `"unknown"` which gets score 50 (below threshold → conservative structured mode)

### Heartbeat Context Injection
- `heartbeat.ts` is 4000+ lines with multiple code paths
- Search for where `contextSnapshot` is read and incorporated into agent prompt
- The sequential instructions should be ADDITIVE, not replace existing context
- Key function: `claimQueuedRun` (line 1744) and context building around lines 380-410

### addComment Service Signature
- Current signature: `(issueId: string, body: string, actor: { agentId?: string; userId?: string })`
- Extend to: `(issueId: string, body: string, actor: { agentId?: string; userId?: string; contributionType?: string; claimedRole?: string })`
- The route layer must parse `contributionType` and `claimedRole` from request body and pass through

### Sequential Advance Timing
- Only advance when `contributionType` is `"output"` or `"abstain"`
- `"role_claim"` is informational, doesn't advance the queue
- Check `processingOrder` exists before attempting advance (guards against structured mode)

### Processing Order Generation
- `generateProcessingOrder` returns agent IDs ordered by `createdAt` (deterministic)
- Only includes `status = 'active'` agents
- Empty array means no sequential processing possible

### Race Condition Prevention
- The provision endpoint already has atomic status transition (lines 352-366)
- Sequential advance should use similar pattern: check position before advancing

### Type Exports
- `OnboardingDiscoveryData` and `OnboardingRecommendationData` are exported from `packages/db/src/schema/onboarding_sessions.ts`
- May need to add new types to shared package if used across boundaries

---

## 4. Review Checklist

### TypeScript Correctness
- [ ] No `any` casts without inline justification comment
- [ ] All new function signatures have explicit return types
- [ ] JSONB columns properly typed with `$type<T>()`
- [ ] Enum types match between shared validators and schema

### Database Schema
- [ ] Migration file is valid PostgreSQL (not SQLite)
- [ ] `DEFAULT` values set correctly
- [ ] New columns are nullable OR have DEFAULT (to not break existing rows)
- [ ] No breaking changes to existing indexes

### Drizzle Schema
- [ ] New columns added to correct schema files
- [ ] Column names match migration (snake_case in SQL, camelCase in TS)
- [ ] Foreign key references added if needed
- [ ] Index additions if needed for query performance

### OnboardingChat Component
- [ ] Handles loading state (initial session fetch)
- [ ] Handles error state (API failures with retry option)
- [ ] Handles empty state (before first message)
- [ ] Handles complete state (recommendation card)
- [ ] Input disabled during API call
- [ ] Auto-scroll on new messages
- [ ] Keyboard support (Enter to send)
- [ ] Proper cleanup on unmount

### Coordination Mode Flow
- [ ] `coordinationMode` passed through entire provision chain
- [ ] Default is `"structured"` (not breaking existing companies)
- [ ] `"auto"` mode correctly resolves based on agent models
- [ ] Company settings UI shows current mode correctly

### Sequential Processing
- [ ] `advanceSequentialIssue` only called when `processingOrder` exists
- [ ] Position increments correctly (0-indexed)
- [ ] Last agent completion marks issue as `"done"`
- [ ] Wakeup payload includes sequential context
- [ ] Predecessor outputs fetched efficiently (no N+1)

### API Responses
- [ ] GET `/issues/:id` includes `processingOrder`, `processingPosition`, `processingStartedAt`
- [ ] GET `/issues/:id/comments` includes `contributionType`, `claimedRole`
- [ ] GET `/companies/:id` includes `coordinationMode`
- [ ] POST `/onboarding/:id/provision` returns `{ companyId, companyPrefix }`

### Tests
- [ ] All unit tests pass
- [ ] New tests cover happy path
- [ ] New tests cover edge cases (empty agents, unknown models, etc.)
- [ ] No hardcoded data in production code

### UI/UX
- [ ] Coordination mode selector is PROMINENT in onboarding (not hidden)
- [ ] Coordination mode selector is PROMINENT in company settings
- [ ] "Auto (Recommended)" is first option
- [ ] Sequential progress bar appears only when `processingOrder` exists
- [ ] Contribution badges render correctly

---

## 5. Test Architecture

### `server/src/services/__tests__/coordination-mode.test.ts`

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

  it("returns 'structured' when auto + unknown model", () => {
    expect(resolveCoordinationMode("auto", ["totally-unknown-model"])).toBe("structured");
  });

  it("normalizes model names with provider prefixes", () => {
    expect(resolveCoordinationMode("auto", ["anthropic/claude-opus-4-6"])).toBe("sequential");
  });
});

describe("normalizeModelName", () => {
  it("strips provider prefix", () => {
    expect(normalizeModelName("anthropic/claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("lowercases the result", () => {
    expect(normalizeModelName("Claude-Opus-4-6")).toBe("claude-opus-4-6");
  });

  it("handles no prefix", () => {
    expect(normalizeModelName("gpt-5")).toBe("gpt-5");
  });
});
```

---

### `server/src/services/__tests__/sequential-coordinator.test.ts`

```typescript
describe("advanceSequentialIssue", () => {
  // Setup: mock db, mock heartbeat.wakeup

  it("advances processingPosition by 1 after agent output");
  it("advances processingPosition by 1 after agent abstention");
  it("updates assigneeAgentId to next agent in sequence");
  it("wakes next agent with sequential context");
  it("marks issue done when last agent completes");
  it("marks issue done when last agent abstains");
  it("no-ops if issue not found");
  it("no-ops if issue has no processingOrder");
});

describe("getPredecessorContributions", () => {
  it("returns all comments with non-null contributionType, ordered by createdAt");
  it("returns empty array for issues with no sequential comments");
  it("includes agent name, body, contributionType, claimedRole");
});

describe("generateProcessingOrder", () => {
  it("returns active agent IDs ordered by createdAt");
  it("excludes inactive agents");
  it("returns empty array if no active agents");
});
```

---

### `server/src/__tests__/onboarding-routes.test.ts` (extend existing)

```typescript
describe("POST /api/onboarding/:sessionId/provision", () => {
  it("accepts coordinationMode parameter");
  it("sets coordinationMode on created company");
  it("defaults to 'structured' when coordinationMode not provided");
  it("rejects invalid coordinationMode values");
  it("returns companyId and companyPrefix");
});
```

---

### `ui/src/components/__tests__/OnboardingChat.test.tsx`

```typescript
describe("OnboardingChat", () => {
  it("calls onboardingApi.start() on mount");
  it("displays initial greeting message from API");
  it("sends user message via onboardingApi.sendMessage()");
  it("displays assistant responses");
  it("shows recommendation card when isComplete=true");
  it("recommendation card includes coordination mode selector");
  it("'Auto' is pre-selected as default coordination mode");
  it("calls onboardingApi.provision() with coordinationMode on submit");
  it("disables input while waiting for API response");
  it("shows error message on API failure");
  it("allows retry after error");
  it("calls onComplete with companyId and companyPrefix after provision");
});
```

---

### Integration Tests

```typescript
describe("concierge + self-org e2e", () => {
  it("new user → OnboardingChat → 3 exchanges → recommendation shown");
  it("provision with coordinationMode='sequential' → company.coordinationMode === 'sequential'");
  it("create issue in sequential company → processingOrder populated");
  it("first agent wakes, posts output → advances to second agent");
  it("second agent sees predecessor output in context");
  it("agent abstains → advances without contribution");
  it("last agent completes → issue status 'done'");
  it("company coordinationMode='auto' + strong models → resolves to sequential");
  it("company coordinationMode='auto' + weak models → resolves to structured");
  it("switch mode in company settings → new issues use new mode, existing unaffected");
});
```

---

## Summary

This plan covers:
- **5 new files**: API client, OnboardingChat component, coordination-mode resolver, sequential-coordinator, SQL migration
- **12+ modified files**: schemas, validators, routes, services, UI pages
- **Comprehensive testing**: unit tests for new services, component tests, integration tests

Key architectural decisions:
1. Model capability scoring with threshold for auto-mode resolution
2. Sequential processing via agent queue stored in issue `processingOrder`
3. Predecessor context injection via heartbeat system
4. Prominent (not hidden) coordination mode UI in onboarding and settings
5. Backward-compatible defaults (`structured` mode, NULL sequential fields)
