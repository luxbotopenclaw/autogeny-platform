import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildHermesGatewayConfig(_v: CreateConfigValues): Record<string, unknown> {
  return {
    timeoutSec: 120,
    pollIntervalMs: 500,
    skipLivenessCheck: false,
  };
}
