import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HermesGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!isCreate && (
        <Field label="Workspace directory">
          <DraftInput
            value={eff("adapterConfig", "workspaceDir", String(config.workspaceDir ?? ""))}
            onCommit={(v) => mark("adapterConfig", "workspaceDir", v || undefined)}
            immediate
            className={inputClass}
            placeholder="/workspace"
          />
        </Field>
      )}

      {!isCreate && (
        <>
          <Field label="Inbox directory">
            <DraftInput
              value={eff("adapterConfig", "inboxDir", String(config.inboxDir ?? ""))}
              onCommit={(v) => mark("adapterConfig", "inboxDir", v || undefined)}
              immediate
              className={inputClass}
              placeholder="{workspaceDir}/.hermes/inbox"
            />
          </Field>

          <Field label="Outbox directory">
            <DraftInput
              value={eff("adapterConfig", "outboxDir", String(config.outboxDir ?? ""))}
              onCommit={(v) => mark("adapterConfig", "outboxDir", v || undefined)}
              immediate
              className={inputClass}
              placeholder="{workspaceDir}/.hermes/outbox"
            />
          </Field>

          <Field label="PID file path">
            <DraftInput
              value={eff("adapterConfig", "pidFile", String(config.pidFile ?? ""))}
              onCommit={(v) => mark("adapterConfig", "pidFile", v || undefined)}
              immediate
              className={inputClass}
              placeholder="{workspaceDir}/.hermes/hermes.pid"
            />
          </Field>

          <Field label="Paperclip API URL override">
            <DraftInput
              value={eff("adapterConfig", "paperclipApiUrl", String(config.paperclipApiUrl ?? ""))}
              onCommit={(v) => mark("adapterConfig", "paperclipApiUrl", v || undefined)}
              immediate
              className={inputClass}
              placeholder="https://paperclip.example"
            />
          </Field>

          <Field label="Timeout (seconds)">
            <DraftInput
              value={eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? "120"))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark(
                  "adapterConfig",
                  "timeoutSec",
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                );
              }}
              immediate
              className={inputClass}
              placeholder="120"
            />
          </Field>

          <Field label="Poll interval (ms)">
            <DraftInput
              value={eff("adapterConfig", "pollIntervalMs", String(config.pollIntervalMs ?? "500"))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark(
                  "adapterConfig",
                  "pollIntervalMs",
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                );
              }}
              immediate
              className={inputClass}
              placeholder="500"
            />
          </Field>
        </>
      )}
    </>
  );
}
