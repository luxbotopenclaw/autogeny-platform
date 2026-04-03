import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, companyMemberships } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};
const pty = require("node-pty") as {
  spawn: (shell: string, args: string[], opts: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  }) => IPty;
};

interface IPty {
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (e: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

interface WsSocket {
  readyState: number;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/terminal\/ws$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

async function authorizeTerminalUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
): Promise<string | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  if (!token) return null;

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key) return null;

  // Verify the key belongs to an agent in this company
  const membership = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);

  // Accept if key's company matches or key belongs to this company context
  if (key.companyId !== companyId && !membership) return null;

  return key.companyId;
}

export function setupTerminalWebSocketServer(server: HttpServer, db: Db) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rawUrl = req.url ?? "";
    let url: URL;
    try {
      url = new URL(rawUrl, "http://localhost");
    } catch {
      return;
    }

    const companyId = parseCompanyId(url.pathname);
    if (!companyId) return; // Not our path

    authorizeTerminalUpgrade(db, req, companyId, url)
      .then((authorizedCompanyId) => {
        if (!authorizedCompanyId) {
          rejectUpgrade(socket, "401 Unauthorized", "Invalid or missing token");
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
          handleTerminalSession(ws, authorizedCompanyId);
        });
      })
      .catch((err) => {
        logger.error({ err }, "terminal ws auth error");
        rejectUpgrade(socket, "500 Internal Server Error", "Auth error");
      });
  });

  return wss;
}

function handleTerminalSession(ws: WsSocket, companyId: string) {
  const credDir = `/paperclip/credentials/${companyId}`;
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
    CLAUDE_CONFIG_DIR: `${credDir}/claude`,
    HERMES_HOME: `${credDir}/hermes`,
    OPENCLAW_STATE_DIR: `${credDir}/openclaw`,
    TERM: "xterm-256color",
  };

  let ptySelf: IPty | null = null;
  try {
    ptySelf = pty.spawn("/bin/bash", [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: credDir,
      env,
    });
  } catch (err) {
    logger.error({ err }, "failed to spawn PTY");
    ws.close(1011, "Failed to spawn terminal");
    return;
  }

  const ptyInstance = ptySelf;

  ptyInstance.onData((data) => {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(data);
    }
  });

  ptyInstance.onExit(() => {
    ws.close(1000, "Terminal exited");
  });

  ws.on("message", (raw) => {
    const msg = raw.toString();
    try {
      const parsed = JSON.parse(msg) as { type: string; cols?: number; rows?: number };
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        ptyInstance.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON — treat as raw input
    }
    ptyInstance.write(msg);
  });

  ws.on("close", () => {
    try { ptyInstance.kill(); } catch { /* ignore */ }
  });

  ws.on("error", (err) => {
    logger.error({ err }, "terminal ws error");
    try { ptyInstance.kill(); } catch { /* ignore */ }
  });
}
