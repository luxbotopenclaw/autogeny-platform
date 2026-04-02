import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { saveLayoutSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import {
  getUserLayout,
  getDefaultLayout,
  saveUserLayout,
  saveDefaultLayout,
} from "../services/office-layout.js";
import { getCompanyPresence } from "../services/claw3d-presence.js";

export function officeLayoutRoutes(db: Db) {
  const router = Router();

  // GET /api/companies/:companyId/office/layout
  // Returns the current user's layout or falls back to the company default
  router.get("/companies/:companyId/office/layout", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId ?? null;
    if (!userId) {
      const layout = await getDefaultLayout(db, companyId);
      res.json(layout ?? null);
      return;
    }
    const layout = await getUserLayout(db, companyId, userId);
    res.json(layout ?? null);
  });

  // PUT /api/companies/:companyId/office/layout
  // Save the current user's layout
  router.put("/companies/:companyId/office/layout", validate(saveLayoutSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId;
    if (!userId) {
      res.status(400).json({ error: "User authentication required to save layout" });
      return;
    }
    const layout = await saveUserLayout(db, companyId, userId, req.body.layoutData);
    res.json(layout);
  });

  // GET /api/companies/:companyId/office/layout/default
  // Returns the company-wide default layout
  router.get("/companies/:companyId/office/layout/default", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const layout = await getDefaultLayout(db, companyId);
    res.json(layout ?? null);
  });

  // PUT /api/companies/:companyId/office/layout/default
  // Admin sets the company-wide default layout
  router.put("/companies/:companyId/office/layout/default", validate(saveLayoutSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertInstanceAdmin(req);
    const layout = await saveDefaultLayout(db, companyId, req.body.layoutData);
    res.json(layout);
  });

  // GET /api/companies/:companyId/office/presence
  // Returns all agents with their mapped Claw3D presence status
  router.get("/companies/:companyId/office/presence", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const presence = await getCompanyPresence(db, companyId);
    res.json(presence);
  });

  return router;
}
