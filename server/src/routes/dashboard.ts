import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { getMergeQueueStats } from "../services/merge-queue.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  /**
   * GET /companies/:companyId/merge-queue/stats
   *
   * Returns live merge queue stats scoped to this company.
   * Shows how many merges are queued/active and per-branch breakdown.
   */
  router.get("/companies/:companyId/merge-queue/stats", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const allStats = getMergeQueueStats();
    const companyBranches = allStats.branches.filter((b) => b.companyId === companyId);
    const stats = {
      totalQueued: companyBranches.reduce((sum, b) => sum + b.queuedCount, 0),
      totalActive: companyBranches.filter((b) => b.activeItem !== null).length,
      branches: companyBranches,
    };

    res.json(stats);
  });

  return router;
}
