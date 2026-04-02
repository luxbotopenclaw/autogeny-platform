import { describe, expect, it } from "vitest";
import { mapAgentStatusToPresence } from "../services/claw3d-presence.js";

describe("mapAgentStatusToPresence", () => {
  it("maps active to working", () => {
    expect(mapAgentStatusToPresence("active")).toBe("working");
  });

  it("maps thinking to working", () => {
    expect(mapAgentStatusToPresence("thinking")).toBe("working");
  });

  it("maps idle to idle", () => {
    expect(mapAgentStatusToPresence("idle")).toBe("idle");
  });

  it("maps sleeping to offline", () => {
    expect(mapAgentStatusToPresence("sleeping")).toBe("offline");
  });

  it("maps error to offline", () => {
    expect(mapAgentStatusToPresence("error")).toBe("offline");
  });

  it("maps paused to offline", () => {
    expect(mapAgentStatusToPresence("paused")).toBe("offline");
  });

  it("maps unknown status to offline", () => {
    expect(mapAgentStatusToPresence("unknown-status")).toBe("offline");
  });

  it("maps empty string to offline", () => {
    expect(mapAgentStatusToPresence("")).toBe("offline");
  });
});
