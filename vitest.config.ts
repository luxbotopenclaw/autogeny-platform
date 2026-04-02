import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/hermes-gateway",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
