/**
 * Merge Queue type definitions.
 *
 * Used by the merge-queue service for in-memory queue stats and merge outcomes.
 */

export interface MergeQueueActiveItem {
  workspaceId: string;
  issueId: string | null;
  branchName: string;
  enqueuedAt: string;
}

export interface MergeQueueBranchStats {
  key: string;
  companyId: string;
  baseRef: string;
  queuedCount: number;
  activeItem: MergeQueueActiveItem | null;
}

export interface MergeQueueStats {
  totalQueued: number;
  totalActive: number;
  branches: MergeQueueBranchStats[];
}

export type MergeQueueOutcome =
  | { status: "succeeded" }
  | { status: "skipped" }
  | { status: "failed"; reason: string; round: number; escalated: boolean };
