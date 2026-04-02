/**
 * Hermes Gateway Adapter — shared constants and config defaults.
 *
 * Hermes uses file-based messaging:
 *   inbox:  write {runId}.json → Hermes reads and wakes the agent
 *   outbox: read  {runId}.json → adapter reads result and returns it
 *
 * Process liveness is checked via `kill -0 <pid>` using a pid file.
 */

export const ADAPTER_TYPE = "hermes_gateway" as const;

// Default paths relative to the Hermes workspace root
export const DEFAULT_WORKSPACE_DIR = "/workspace";
export const DEFAULT_INBOX_SUBPATH = ".hermes/inbox";
export const DEFAULT_OUTBOX_SUBPATH = ".hermes/outbox";
export const DEFAULT_PID_FILE_SUBPATH = ".hermes/hermes.pid";
export const DEFAULT_CONFIG_DIR = "~/.hermes";

// Timing defaults
export const DEFAULT_TIMEOUT_SEC = 120;
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

// Inbox message schema version (for forward compatibility)
export const INBOX_MESSAGE_VERSION = 1;

// Log prefix used by the adapter in all stdout lines
export const LOG_PREFIX = "[hermes-gateway]";
export const LOG_PREFIX_EVENT = "[hermes-gateway:event]";
