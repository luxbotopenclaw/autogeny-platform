import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a single stdout line from the hermes-gateway adapter into
 * zero or more TranscriptEntry values.
 *
 * Line format examples:
 *   [hermes-gateway] wake message written to /workspace/.hermes/inbox/abc.json
 *   [hermes-gateway:event] run=abc stream=lifecycle data={"phase":"ok","model":"claude-3-5-sonnet"}
 *   [hermes-gateway] run completed runId=abc status=ok
 */
function parseEventLine(line: string, ts: string): TranscriptEntry[] {
  const match = line.match(
    /^\[hermes-gateway:event\]\s+run=([^\s]+)\s+stream=([^\s]+)\s+data=(.*)$/s,
  );
  if (!match) return [{ kind: "stdout", ts, text: line }];

  const stream = asString(match[2]).toLowerCase();
  const data = asRecord(safeJsonParse(asString(match[3]).trim()));

  if (stream === "assistant") {
    const delta = asString(data?.delta);
    if (delta.length > 0) return [{ kind: "assistant", ts, text: delta, delta: true }];
    const text = asString(data?.text);
    if (text.length > 0) return [{ kind: "assistant", ts, text }];
    return [];
  }

  if (stream === "error") {
    const message = asString(data?.error) || asString(data?.message);
    return message ? [{ kind: "stderr", ts, text: message }] : [];
  }

  if (stream === "lifecycle") {
    const phase = asString(data?.phase).toLowerCase();
    const message = asString(data?.error) || asString(data?.message);
    if ((phase === "error" || phase === "failed" || phase === "timeout") && message) {
      return [{ kind: "stderr", ts, text: message }];
    }
  }

  return [];
}

export function parseHermesGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[hermes-gateway:event]")) {
    return parseEventLine(trimmed, ts);
  }

  if (trimmed.startsWith("[hermes-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: trimmed }];
}
