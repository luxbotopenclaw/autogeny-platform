import { describe, it, expect } from "vitest";
import { parseHermesGatewayStdoutLine } from "../ui/parse-stdout.js";

const TS = "2026-04-02T00:00:00.000Z";

describe("parseHermesGatewayStdoutLine", () => {
  it("returns empty array for empty line", () => {
    expect(parseHermesGatewayStdoutLine("", TS)).toEqual([]);
    expect(parseHermesGatewayStdoutLine("   ", TS)).toEqual([]);
  });

  it("parses [hermes-gateway] system lines", () => {
    const entries = parseHermesGatewayStdoutLine(
      "[hermes-gateway] wake message written to /workspace/.hermes/inbox/run1.json",
      TS,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "system",
      ts: TS,
      text: "wake message written to /workspace/.hermes/inbox/run1.json",
    });
  });

  it("parses [hermes-gateway] run completed line", () => {
    const entries = parseHermesGatewayStdoutLine(
      "[hermes-gateway] run completed runId=abc status=ok",
      TS,
    );
    expect(entries[0]).toMatchObject({ kind: "system", ts: TS });
  });

  it("parses [hermes-gateway:event] assistant delta stream", () => {
    const line =
      '[hermes-gateway:event] run=run1 stream=assistant data={"delta":"Hello world"}';
    const entries = parseHermesGatewayStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "assistant",
      ts: TS,
      text: "Hello world",
      delta: true,
    });
  });

  it("parses [hermes-gateway:event] assistant text stream", () => {
    const line =
      '[hermes-gateway:event] run=run1 stream=assistant data={"text":"Full response"}';
    const entries = parseHermesGatewayStdoutLine(line, TS);
    expect(entries[0]).toMatchObject({ kind: "assistant", ts: TS, text: "Full response" });
    expect(entries[0]).not.toHaveProperty("delta");
  });

  it("returns empty array for assistant event with no text or delta", () => {
    const line = '[hermes-gateway:event] run=run1 stream=assistant data={}';
    const entries = parseHermesGatewayStdoutLine(line, TS);
    expect(entries).toHaveLength(0);
  });

  it("parses [hermes-gateway:event] error stream", () => {
    const line =
      '[hermes-gateway:event] run=run1 stream=error data={"error":"Something failed"}';
    const entries = parseHermesGatewayStdoutLine(line, TS);
    expect(entries[0]).toMatchObject({ kind: "stderr", ts: TS, text: "Something failed" });
  });

  it("parses [hermes-gateway:event] lifecycle error phase", () => {
    const line =
      '[hermes-gateway:event] run=run1 stream=lifecycle data={"phase":"error","message":"Agent crashed"}';
    const entries = parseHermesGatewayStdoutLine(line, TS);
    expect(entries[0]).toMatchObject({ kind: "stderr", ts: TS, text: "Agent crashed" });
  });

  it("returns empty array for lifecycle ok phase with no message", () => {
    const line =
      '[hermes-gateway:event] run=run1 stream=lifecycle data={"phase":"ok","model":"claude-3-5-sonnet"}';
    const entries = parseHermesGatewayStdoutLine(line, TS);
    expect(entries).toHaveLength(0);
  });

  it("returns stdout entry for unrecognized lines", () => {
    const entries = parseHermesGatewayStdoutLine("some random output", TS);
    expect(entries[0]).toMatchObject({ kind: "stdout", ts: TS, text: "some random output" });
  });

  it("falls back to stdout for malformed event lines", () => {
    const line = "[hermes-gateway:event] this is not valid event format";
    const entries = parseHermesGatewayStdoutLine(line, TS);
    // Falls back to stdout since it can't parse run= stream= data= pattern
    expect(entries[0]).toMatchObject({ kind: "stdout" });
  });
});
