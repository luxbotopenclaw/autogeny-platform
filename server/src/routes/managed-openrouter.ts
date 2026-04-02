/**
 * Admin routes for platform-managed OpenRouter keys.
 *
 * All routes require board auth + company membership.
 * Instance admin routes (create company key) require assertInstanceAdmin.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { managedOpenRouterService } from "../services/managed-openrouter.js";

export function managedOpenRouterRoutes(db: Db) {
  const router = Router();
  const svc = managedOpenRouterService(db);

  /**
   * GET /api/admin/companies/:companyId/managed-openrouter-keys
   * List all managed OpenRouter keys for a company.
   */
  router.get("/admin/companies/:companyId/managed-openrouter-keys", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const keys = await svc.listForCompany(companyId);
    res.json(keys);
  });

  /**
   * POST /api/admin/companies/:companyId/managed-openrouter-keys
   * Create a company-level managed OpenRouter key.
   * Requires instance admin (platform-level operation).
   *
   * Body (optional): { spendingCapCents?: number }
   */
  router.post("/admin/companies/:companyId/managed-openrouter-keys", async (req, res) => {
    assertBoard(req);
    assertInstanceAdmin(req);
    const companyId = req.params.companyId as string;
    const spendingCapCents = typeof req.body?.spendingCapCents === "number"
      ? req.body.spendingCapCents
      : undefined;
    const result = await svc.createCompanyKey(companyId, {
      spendingCapCents,
      actorUserId: req.actor?.userId ?? null,
    });
    res.status(201).json(result);
  });

  /**
   * POST /api/admin/companies/:companyId/agents/:agentId/managed-openrouter-key
   * Provision a per-agent sub-key.
   * Requires board auth + company membership.
   *
   * Body (optional): { spendingCapCents?: number }
   */
  router.post("/admin/companies/:companyId/agents/:agentId/managed-openrouter-key", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.params.agentId as string;
    const spendingCapCents = typeof req.body?.spendingCapCents === "number"
      ? req.body.spendingCapCents
      : undefined;
    const result = await svc.provisionAgentKey(agentId, companyId, {
      spendingCapCents,
      actorUserId: req.actor?.userId ?? null,
    });
    res.status(201).json(result);
  });

  /**
   * DELETE /api/admin/companies/:companyId/agents/:agentId/managed-openrouter-key
   * Revoke a per-agent managed OpenRouter key.
   */
  router.delete("/admin/companies/:companyId/agents/:agentId/managed-openrouter-key", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.params.agentId as string;
    await svc.revokeAgentKey(agentId);
    res.status(204).end();
  });

  /**
   * POST /api/admin/managed-openrouter/poll
   * Manually trigger a usage poll (instance admin only). Useful for testing.
   */
  router.post("/admin/managed-openrouter/poll", async (req, res) => {
    assertBoard(req);
    assertInstanceAdmin(req);
    const result = await svc.pollAllUsage();
    res.json(result);
  });

  return router;
}
