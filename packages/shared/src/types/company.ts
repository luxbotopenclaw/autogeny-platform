import type { CompanyStatus, PauseReason } from "../constants.js";
import type { ReviewMode } from "../validators/company.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  brandColor: string | null;
  /** Review mode for the merge queue: 'standard' skips LLM review, 'semi-formal' runs structured review */
  reviewMode: ReviewMode;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
