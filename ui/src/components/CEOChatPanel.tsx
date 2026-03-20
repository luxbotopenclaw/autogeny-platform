import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueComment } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";
import { cn } from "../lib/utils";
import {
  Loader2,
  Send,
  CheckCircle2,
  Sparkles,
  History,
  Search,
  X,
  Plus,
} from "lucide-react";

export interface ChatConversation {
  id: string;
  title: string;
  lastMessage?: string;
  updatedAt: string;
  isActive?: boolean;
}

interface CEOChatPanelProps {
  taskId: string;
  agentId: string;
  agentName: string;
  companyId: string;
  companyName?: string;
  companyGoal?: string;
  conversations?: ChatConversation[];
  onSwitchConversation?: (taskId: string) => void;
  onNewConversation?: () => void;
  onPlanDetected?: (planMarkdown: string) => void;
  onPlanApproved?: () => void;
  onAgentWorkingChange?: (working: boolean) => void;
  onOpenArtifact?: (key: string, title: string) => void;
}

/** Animated paperclip SVG thinking indicator */
function PaperclipThinking({ className }: { className?: string }) {
  return (
    <img
      src="/paperclip-thinking.svg"
      alt=""
      className={cn("inline-block", className)}
      style={{ width: 14, height: 14 }}
    />
  );
}

/**
 * Detects whether a comment body contains a structured hiring plan.
 */
function detectHiringPlan(body: string): boolean {
  const planPatterns = [
    /##?\s*(hiring|team|org|roles|plan)/i,
    /##?\s*(proposed|recommended)\s*(roles|hires|team)/i,
    /\n-\s+\*\*[^*]+\*\*/g,
    /\|\s*role\s*\|/i,
  ];
  return planPatterns.some((pattern) => pattern.test(body));
}

const QUEUED_MESSAGES = [
  "Heartbeat triggered, waking up...",
  "Initializing...",
  "Getting ready...",
];

const RUNNING_MESSAGES = [
  "Working on a response...",
  "Reading the conversation...",
  "Thinking through the plan...",
  "Drafting a response...",
  "Still working...",
  "Almost there...",
];

const WAITING_MESSAGES = [
  "Waiting to wake up...",
  "Heartbeat pending...",
  "Should wake up soon...",
];

function getCyclingMessage(messages: string[], elapsed: number, agentName: string): string {
  const idx = Math.floor(elapsed / 5) % messages.length;
  return `${agentName} · ${messages[idx]}`;
}

function getRunStatusMessage(status: string, agentName: string, elapsed: number): string {
  switch (status) {
    case "queued":
      return getCyclingMessage(QUEUED_MESSAGES, elapsed, agentName);
    case "running":
      return getCyclingMessage(RUNNING_MESSAGES, elapsed, agentName);
    case "succeeded":
      return `${agentName} finished`;
    case "failed":
      return `${agentName} encountered an error`;
    case "cancelled":
      return `${agentName}'s run was cancelled`;
    case "timed_out":
      return `${agentName}'s run timed out`;
    default:
      return `${agentName} is thinking...`;
  }
}

/** Stepped progress indicator for long waits */
function getProgressStep(elapsed: number): string | null {
  if (elapsed < 10) return null;
  if (elapsed < 30) return "Analyzing your mission...";
  if (elapsed < 60) return "Drafting the plan...";
  if (elapsed < 90) return "Detailing roles and responsibilities...";
  return "Almost ready...";
}

/** Context-aware suggestion chips */
function getSuggestionChips(
  hasActiveRun: boolean,
  hasPlanDetected: boolean,
  hasComments: boolean,
): Array<{ label: string; message: string }> {
  if (hasPlanDetected) {
    return [
      { label: "I want to make changes", message: "I'd like to make some changes to the plan before approving." },
      { label: "Add another role", message: "Can you add another role to the plan?" },
    ];
  }
  if (hasActiveRun) {
    return [
      { label: "What can I do while waiting?", message: "What can I do while you're working on the plan?" },
      { label: "Tell me about team structure", message: "Tell me about how you're thinking about the team structure." },
    ];
  }
  if (hasComments) {
    return [
      { label: "What should we prioritize?", message: "What should we prioritize first?" },
      { label: "Create a new project", message: "Let's create a new project to work on." },
    ];
  }
  return [
    { label: "Let's talk strategy", message: "Before we hire anyone, I'd like to discuss our strategy and priorities." },
    { label: "What do you need from me?", message: "What information do you need from me to get started?" },
  ];
}

export function CEOChatPanel({
  taskId,
  agentId,
  agentName,
  companyId,
  companyName,
  companyGoal,
  conversations,
  onSwitchConversation,
  onNewConversation,
  onPlanDetected,
  onPlanApproved,
  onAgentWorkingChange,
  onOpenArtifact,
}: CEOChatPanelProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [detectedPlanCommentId, setDetectedPlanCommentId] = useState<string | null>(null);
  const [ignoreBeforeCommentId, setIgnoreBeforeCommentId] = useState<string | null>(null);
  const [usePaperclipIndicator, setUsePaperclipIndicator] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSearch, setDrawerSearch] = useState("");
  // Welcome typing animation — phases: typing → message
  const [welcomePhase, setWelcomePhase] = useState<"typing" | "message">("typing");
  // Optimistic typing indicator — shows immediately after user sends
  const [optimisticTyping, setOptimisticTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Poll comments — faster when waiting for a response
  const { data: rawComments, isLoading } = useQuery({
    queryKey: queryKeys.issues.comments(taskId),
    queryFn: () => issuesApi.listComments(taskId),
    refetchInterval: optimisticTyping ? 2000 : 4000,
  });

  // Poll heartbeat — faster when actively waiting
  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(taskId),
    queryFn: () => heartbeatsApi.activeRunForIssue(taskId),
    refetchInterval: optimisticTyping ? 1500 : 3000,
  });

  const comments = useMemo(
    () =>
      rawComments
        ? [...rawComments].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )
        : undefined,
    [rawComments],
  );

  // Welcome typing animation — show "typing" for 2.5s then reveal message
  useEffect(() => {
    if (comments && comments.length === 0 && welcomePhase === "typing") {
      const timer = setTimeout(() => setWelcomePhase("message"), 2500);
      return () => clearTimeout(timer);
    }
  }, [comments, welcomePhase]);

  // Clear optimistic typing when a new agent comment arrives
  useEffect(() => {
    if (optimisticTyping && comments?.length) {
      const lastComment = comments[comments.length - 1];
      if (lastComment.authorAgentId) {
        setOptimisticTyping(false);
      }
    }
  }, [comments, optimisticTyping]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [comments?.length]);

  // Detect hiring plan
  useEffect(() => {
    if (!comments || detectedPlanCommentId) return;

    let cutoffIdx = -1;
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].authorUserId) { cutoffIdx = i; break; }
    }
    if (ignoreBeforeCommentId) {
      const ignoreIdx = comments.findIndex((c) => c.id === ignoreBeforeCommentId);
      if (ignoreIdx >= 0) cutoffIdx = Math.max(cutoffIdx, ignoreIdx);
    }

    for (let i = comments.length - 1; i > cutoffIdx; i--) {
      const c = comments[i];
      if (c.authorAgentId && detectHiringPlan(c.body)) {
        setDetectedPlanCommentId(c.id);
        // Update existing draft artifact to "ready_for_review", or create one
        (async () => {
          try {
            const wps = await issuesApi.listWorkProducts(taskId);
            const existing = wps.find((wp) => wp.title === "Hiring Plan");
            if (existing) {
              await issuesApi.updateWorkProduct(existing.id, {
                status: "ready_for_review",
                reviewState: "needs_board_review",
                summary: "Hiring plan is ready for your review",
              });
            } else {
              await issuesApi.createWorkProduct(taskId, {
                type: "document",
                title: "Hiring Plan",
                provider: "paperclip",
                status: "ready_for_review",
                reviewState: "needs_board_review",
                isPrimary: true,
                summary: "Hiring plan is ready for your review",
              });
            }
          } catch { /* non-critical */ }
        })();
        // Notify parent
        issuesApi.getDocument(taskId, "plan").then((doc) => {
          onPlanDetected?.(doc.body ?? c.body);
        }).catch(() => {
          onPlanDetected?.(c.body);
        });
        // Invalidate work products so ArtifactsPanel picks it up
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.workProducts(taskId),
        });
        break;
      }
    }
  }, [comments, detectedPlanCommentId, ignoreBeforeCommentId, taskId, onPlanDetected, queryClient]);

  // Streaming response state
  const [streamingText, setStreamingText] = useState("");

  // Send message — try streaming relay first, fall back to poll-based
  const sendMessage = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setInput("");
    setOptimisticTyping(true);

    const latestId = comments?.[comments.length - 1]?.id ?? null;
    setIgnoreBeforeCommentId(latestId);
    setDetectedPlanCommentId(null);

    // Ensure task is assigned to agent
    try {
      await issuesApi.update(taskId, { assigneeUserId: null });
    } catch { /* ok */ }
    try {
      await issuesApi.update(taskId, { assigneeAgentId: agentId, status: "in_progress" });
    } catch { /* ok */ }

    try {
      // Try streaming relay
      const res = await fetch(`/api/agents/${agentId}/chat/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, message: trimmed }),
      });

      if (!res.ok || !res.body) {
        throw new Error("Relay not available");
      }

      setOptimisticTyping(false);
      setStreamingText("");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "chunk") {
              setStreamingText((prev) => prev + event.text);
            } else if (event.type === "done") {
              setStreamingText("");
              // Refresh comments to pick up persisted messages
              queryClient.invalidateQueries({
                queryKey: queryKeys.issues.comments(taskId),
              });
            } else if (event.type === "error") {
              setStreamingText("");
              // Fall through — comments will still be polled
            }
          } catch { /* malformed SSE line, skip */ }
        }
      }

      setStreamingText("");
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(taskId),
      });
    } catch {
      // Fallback: use the old comment-and-poll approach
      try {
        await issuesApi.addComment(taskId, trimmed, true, true);
      } catch { /* already saved by relay, or genuinely failed */ }
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(taskId),
      });
    } finally {
      setSending(false);
      setOptimisticTyping(false);
      inputRef.current?.focus();
    }
  }, [sending, taskId, agentId, queryClient, comments]);

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Status indicators
  const lastComment = comments?.[comments.length - 1];
  const isWaitingForAgent = lastComment && lastComment.authorUserId && !lastComment.authorAgentId;
  const hasActiveRun = activeRun && (activeRun.status === "queued" || activeRun.status === "running");
  const showStatus = isWaitingForAgent || hasActiveRun;

  // Notify parent of working state changes
  useEffect(() => {
    onAgentWorkingChange?.(!!showStatus);
  }, [showStatus, onAgentWorkingChange]);

  // Elapsed timer
  const [elapsed, setElapsed] = useState(0);
  const waitingSince = useMemo(() => {
    if (!showStatus || !lastComment) return null;
    if (lastComment.authorUserId) return new Date(lastComment.createdAt).getTime();
    if (hasActiveRun && activeRun.createdAt) return new Date(activeRun.createdAt).getTime();
    return null;
  }, [showStatus, lastComment, hasActiveRun, activeRun]);

  useEffect(() => {
    if (!waitingSince) { setElapsed(0); return; }
    setElapsed(Math.floor((Date.now() - waitingSince) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - waitingSince) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [waitingSince]);

  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  const progressStep = getProgressStep(elapsed);
  const suggestionChips = getSuggestionChips(!!hasActiveRun, !!detectedPlanCommentId, !!comments?.length);

  // Dynamic placeholder
  const placeholder = hasActiveRun
    ? `${agentName} is working...`
    : detectedPlanCommentId
      ? "Ask your CEO to revise the plan..."
      : "Send a message...";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Loading conversation...
      </div>
    );
  }

  const filteredConversations = (conversations ?? []).filter((c) =>
    !drawerSearch || c.title.toLowerCase().includes(drawerSearch.toLowerCase()),
  );

  return (
    <div className="flex flex-col h-full relative">
      {/* Chat header */}
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <button
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
          onClick={() => setDrawerOpen(true)}
          title="Chat history"
        >
          <History className="h-4 w-4" />
        </button>
        <span className="text-[13px] font-medium flex-1 truncate">{agentName}</span>
      </div>

      {/* Chat history drawer — slides over chat */}
      {drawerOpen && (
        <div className="absolute inset-0 z-20 bg-background flex flex-col animate-in slide-in-from-left duration-200">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
            <button
              className="text-muted-foreground hover:text-foreground p-1 rounded"
              onClick={() => { setDrawerOpen(false); setDrawerSearch(""); }}
            >
              <X className="h-4 w-4" />
            </button>
            <span className="text-[13px] font-medium flex-1">Conversations</span>
            {onNewConversation && (
              <button
                className="text-muted-foreground hover:text-foreground p-1 rounded"
                onClick={onNewConversation}
                title="New conversation"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="px-3 py-2 border-b border-border">
            <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/50"
                placeholder="Search conversations..."
                value={drawerSearch}
                onChange={(e) => setDrawerSearch(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-auto-hide">
            {filteredConversations.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                {conversations?.length === 0 ? "No conversations yet" : "No matches"}
              </div>
            ) : (
              filteredConversations.map((conv) => (
                <button
                  key={conv.id}
                  className={cn(
                    "w-full text-left px-3 py-2.5 border-b border-border hover:bg-accent/30 transition-colors",
                    conv.isActive && "bg-accent/50",
                  )}
                  onClick={() => {
                    onSwitchConversation?.(conv.id);
                    setDrawerOpen(false);
                    setDrawerSearch("");
                  }}
                >
                  <p className="text-[13px] font-medium truncate">{conv.title}</p>
                  {conv.lastMessage && (
                    <p className="text-[11px] text-muted-foreground truncate mt-0.5">{conv.lastMessage}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                    {new Date(conv.updatedAt).toLocaleDateString()}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Progress step indicator */}
      {showStatus && progressStep && (
        <div className="px-4 py-2 border-b border-border bg-muted/30 text-xs text-muted-foreground flex items-center gap-2">
          <Sparkles className="h-3 w-3 animate-pulse" />
          {progressStep}
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scrollbar-auto-hide space-y-2.5 p-4"
      >
        {/* CEO Welcome — typing indicator then message */}
        {comments?.length === 0 && welcomePhase === "typing" && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground px-3 py-2">
            {usePaperclipIndicator ? (
              <PaperclipThinking />
            ) : (
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
              </span>
            )}
            {agentName} is composing a message...
          </div>
        )}
        {comments?.length === 0 && welcomePhase === "message" && (
          <div className="rounded-md px-2.5 py-1.5 text-[13px] leading-relaxed bg-muted/50 border border-border mr-6 animate-in fade-in duration-300">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {agentName}
              </span>
            </div>
            <p>
              Hello! I'm <strong>{agentName}</strong>{companyName ? <>, your CEO at <strong>{companyName}</strong></> : ", your CEO"}.
            </p>
            {companyGoal && (
              <p className="mt-0.5">
                Our mission: <em>{companyGoal}</em>
              </p>
            )}
            <p className="mt-0.5">
              I'd love to understand your vision and priorities before we start building the team. What's most important to you right now?
            </p>
          </div>
        )}

        {comments?.map((comment) => {
          const isAgent = Boolean(comment.authorAgentId);
          const isPlan = detectedPlanCommentId === comment.id;
          return (
            <div key={comment.id}>
              <div
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-[13px] leading-relaxed",
                  isAgent
                    ? "bg-muted/50 border border-border mr-6"
                    : "bg-accent/50 border border-accent ml-6",
                )}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span
                    className={cn(
                      "text-[10px] font-medium uppercase tracking-wide",
                      isAgent ? "text-muted-foreground" : "text-foreground/70",
                    )}
                  >
                    {isAgent ? agentName : "You"}
                  </span>
                  {isPlan && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400 font-medium">
                      <CheckCircle2 className="h-3 w-3" />
                      Hiring plan detected
                    </span>
                  )}
                </div>
                <div className="prose prose-xs dark:prose-invert max-w-none text-[13px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                  <MarkdownBody>
                    {isAgent
                      ? comment.body.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
                      : comment.body}
                  </MarkdownBody>
                </div>
              </div>

              {/* Inline plan link — opens in artifacts pane */}
              {isPlan && (
                <button
                  className="flex items-center gap-1.5 mt-1 mr-6 px-2.5 py-1.5 rounded-md border border-green-500/30 bg-green-500/5 hover:bg-green-500/10 transition-colors text-left"
                  onClick={() => onOpenArtifact?.("plan", "Hiring Plan")}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  <span className="text-[12px] font-medium">Hiring Plan</span>
                  <span className="text-[11px] text-muted-foreground">— tap to review in Artifacts</span>
                </button>
              )}
            </div>
          );
        })}

        {/* Status indicator — click to toggle between paperclip SVG and blue dot */}
        {showStatus && (
          <button
            className="flex items-center justify-between text-[12px] text-muted-foreground px-3 py-1.5 w-full text-left hover:bg-muted/30 transition-colors"
            onClick={() => setUsePaperclipIndicator((v) => !v)}
            title="Click to toggle thinking indicator style"
          >
            <div className="flex items-center gap-2">
              {hasActiveRun ? (
                <>
                  {usePaperclipIndicator ? (
                    <PaperclipThinking />
                  ) : (
                    <span className="relative flex h-2.5 w-2.5 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
                    </span>
                  )}
                  {getRunStatusMessage(activeRun.status, agentName, elapsed)}
                </>
              ) : (
                <>
                  {usePaperclipIndicator ? (
                    <PaperclipThinking />
                  ) : (
                    <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                  )}
                  {getCyclingMessage(WAITING_MESSAGES, elapsed, agentName)}
                </>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
              {elapsedStr}
            </span>
          </button>
        )}
        {/* Streaming response — shows text as it arrives from the relay */}
        {streamingText && (
          <div className="rounded-md px-2.5 py-1.5 text-[13px] leading-relaxed bg-muted/50 border border-border mr-6 animate-in fade-in duration-150">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {agentName}
              </span>
              <span className="text-[10px] text-cyan-500 font-medium">streaming</span>
            </div>
            <div className="prose prose-xs dark:prose-invert max-w-none text-[13px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <MarkdownBody>{streamingText}</MarkdownBody>
            </div>
          </div>
        )}

        {/* Optimistic typing indicator — shows immediately after user sends */}
        {optimisticTyping && !showStatus && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground px-3 py-1.5">
            {usePaperclipIndicator ? (
              <PaperclipThinking />
            ) : (
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
              </span>
            )}
            {agentName} is typing...
          </div>
        )}
      </div>

      {/* Suggestion chips */}
      <div className="px-3 pb-1.5 flex flex-wrap gap-1">
        {suggestionChips.map((chip) => (
          <button
            key={chip.label}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            onClick={() => sendMessage(chip.message)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Input area */}
      <div className="flex items-center gap-1.5 px-3 pb-3 pt-1.5 border-t border-border">
        <input
          ref={inputRef}
          type="text"
          className="flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <Button
          size="sm"
          disabled={!input.trim() || sending}
          onClick={handleSend}
          className="shrink-0"
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

