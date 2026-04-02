import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "/tmp/vitest-cache-hermes-gateway",
  test: {
    environment: "node",
  },
});
