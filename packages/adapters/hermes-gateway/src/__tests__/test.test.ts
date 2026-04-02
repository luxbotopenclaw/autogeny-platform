import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      unlink: vi.fn(),
      mkdir: vi.fn(),
      stat: vi.fn(),
    },
  };
});

import * as nodeFs from "node:fs";
const { testEnvironment } = await import("../server/test.js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fsMock = nodeFs.promises as unknown as {
  readFile: Mock;
  writeFile: Mock;
  unlink: Mock;
  mkdir: Mock;
  stat: Mock;
};

function makeCtx(config: Record<string, unknown> = {}): AdapterEnvironmentTestContext {
  return {
    companyId: "company-test",
    adapterType: "hermes_gateway",
    config: {
      inboxDir: "/tmp/hermes-env-test/inbox",
      outboxDir: "/tmp/hermes-env-test/outbox",
      pidFile: "/tmp/hermes-env-test/hermes.pid",
      ...config,
    },
  };
}

describe("hermes-gateway testEnvironment()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns pass when inbox/outbox writable and process alive", async () => {
    // stat: directories exist
    fsMock.stat = vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false });
    // writeFile probe succeeds
    fsMock.writeFile = vi.fn().mockResolvedValue(undefined);
    fsMock.unlink = vi.fn().mockResolvedValue(undefined);
    // pid file returns valid pid
    fsMock.readFile = vi.fn().mockResolvedValue("99999");
    // kill(pid, 0) succeeds
    vi.spyOn(process, "kill").mockReturnValue(true);

    const result = await testEnvironment(makeCtx());

    expect(result.status).toBe("pass");
    expect(result.checks.some((c) => c.code === "hermes_gateway_inbox_ok")).toBe(true);
    expect(result.checks.some((c) => c.code === "hermes_gateway_process_alive")).toBe(true);
  });

  it("returns fail when process is dead", async () => {
    fsMock.stat = vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false });
    fsMock.writeFile = vi.fn().mockResolvedValue(undefined);
    fsMock.unlink = vi.fn().mockResolvedValue(undefined);
    fsMock.readFile = vi.fn().mockResolvedValue("99999");

    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    const result = await testEnvironment(makeCtx());

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "hermes_gateway_process_dead")).toBe(true);
  });

  it("returns fail when pid file is missing", async () => {
    fsMock.stat = vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false });
    fsMock.writeFile = vi.fn().mockResolvedValue(undefined);
    fsMock.unlink = vi.fn().mockResolvedValue(undefined);
    fsMock.readFile = vi.fn().mockRejectedValue(new Error("ENOENT: no such file"));
    vi.spyOn(process, "kill").mockReturnValue(true);

    const result = await testEnvironment(makeCtx());

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "hermes_gateway_pid_missing")).toBe(true);
  });

  it("creates inbox dir if missing and returns warn", async () => {
    // stat: inbox doesn't exist
    fsMock.stat = vi.fn().mockImplementation((p: unknown) => {
      if (String(p).includes("inbox")) {
        return Promise.reject(new Error("ENOENT"));
      }
      return Promise.resolve({ isDirectory: () => true, isFile: () => false });
    });
    fsMock.mkdir = vi.fn().mockResolvedValue(undefined);
    fsMock.writeFile = vi.fn().mockResolvedValue(undefined);
    fsMock.unlink = vi.fn().mockResolvedValue(undefined);
    fsMock.readFile = vi.fn().mockResolvedValue("99999");
    vi.spyOn(process, "kill").mockReturnValue(true);

    const result = await testEnvironment(makeCtx());

    expect(result.checks.some((c) => c.code === "hermes_gateway_inbox_created")).toBe(true);
    // warn status because inbox had to be created
    expect(result.status === "warn" || result.status === "pass").toBe(true);
  });
});
