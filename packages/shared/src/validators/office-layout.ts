import { z } from "zod";

export const deskAssignmentSchema = z.object({
  deskId: z.string(),
  agentId: z.string().nullable(),
  x: z.number(),
  y: z.number(),
  rotation: z.number().default(0),
});

export const layoutDataSchema = z
  .object({
    desks: z.array(deskAssignmentSchema).optional(),
    wallColor: z.string().optional(),
    decorations: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const saveLayoutSchema = z.object({
  layoutData: layoutDataSchema,
});

export type DeskAssignment = z.infer<typeof deskAssignmentSchema>;
export type LayoutData = z.infer<typeof layoutDataSchema>;
export type SaveLayoutInput = z.infer<typeof saveLayoutSchema>;
