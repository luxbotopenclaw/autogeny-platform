import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getServerAdapter } from "../adapters/index.js";
import {
  agentService,
  issueService,
  secretService,
} from "../services/index.js";
import { notFound } from "../errors.js";
import { parseObject } from "../adapters/utils.js";

/**
 * Chat relay endpoint — calls the adapter directly and streams the response
 * back via SSE. Bypasses the heartbeat queue for real-time conversation.
 *
 * Comments are persisted normally so the conversation is durable.
 */
export function agentChatRoutes(db: Db) {
  const router = Router();

  router.post("/agents/:id/chat/relay", async (req, res) => {
    const agentId = req.params.id;
    const { taskId, message } = req.body as { taskId: string; message: string };

    if (!taskId || !message) {
      res.status(400).json({ error: "taskId and message are required" });
      return;
    }

    // Look up agent
    const agentSvc = agentService(db);
    const agent = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      throw notFound("Agent not found");
    }

    // Save the user's message as a comment
    const issueSvc = issueService(db);
    await issueSvc.addComment(taskId, message, {
      userId: (req as any).actor?.userId ?? null,
    });

    // Set up SSE streaming response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Send initial event
    res.write(`data: ${JSON.stringify({ type: "start", agentId, agentName: agent.name })}\n\n`);

    try {
      // Resolve adapter config with secrets
      const config = parseObject(agent.adapterConfig);
      const secretsSvc = secretService(db);
      const { config: resolvedConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.companyId,
        config,
      );

      // Get adapter
      const adapter = getServerAdapter(agent.adapterType);

      // Execute directly — stream stdout chunks as SSE events
      let fullResponse = "";
      const startTime = Date.now();

      const result = await adapter.execute({
        runId: randomUUID(),
        agent: agent as any, // DB row matches adapter expectation
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: resolvedConfig,
        context: {
          chatMessage: message,
          taskId,
          issueId: taskId,
          source: "chat_relay",
          wakeReason: "chat_relay",
        },
        onLog: async (stream, chunk) => {
          if (stream === "stdout" && res.writable) {
            fullResponse += chunk;
            res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
          }
        },
        onMeta: async () => {
          // Silently consume metadata
        },
      });

      // Save the agent's full response as a comment
      if (fullResponse.trim()) {
        await issueSvc.addComment(taskId, fullResponse.trim(), {
          agentId: agent.id,
        });
      }

      // Send completion event
      const duration = Date.now() - startTime;
      if (res.writable) {
        res.write(
          `data: ${JSON.stringify({
            type: "done",
            model: result.model ?? null,
            provider: result.provider ?? null,
            costUsd: result.costUsd ?? null,
            duration,
            exitCode: result.exitCode,
          })}\n\n`,
        );
      }
    } catch (err) {
      // Send error event
      if (res.writable) {
        const message = err instanceof Error ? err.message : "Relay execution failed";
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      }
    } finally {
      if (res.writable) {
        res.end();
      }
    }
  });

  return router;
}
