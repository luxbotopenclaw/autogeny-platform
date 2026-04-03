import type { OfficeAgent } from "../../api/office";

interface AgentPresenceSummaryProps {
  agents: OfficeAgent[];
}

const STATUS_LABELS: Record<OfficeAgent["status"], string> = {
  active: "active",
  paused: "paused",
  idle: "idle",
  error: "error",
};

const STATUS_CLASSES: Record<OfficeAgent["status"], string> = {
  active: "bg-green-500/20 text-green-700 dark:text-green-400",
  paused: "bg-amber-500/20 text-amber-700 dark:text-amber-400",
  idle: "bg-gray-500/20 text-gray-600 dark:text-gray-400",
  error: "bg-red-500/20 text-red-700 dark:text-red-400",
};

const STATUS_ORDER: OfficeAgent["status"][] = ["active", "paused", "error", "idle"];

export function AgentPresenceSummary({ agents }: AgentPresenceSummaryProps) {
  const counts = agents.reduce<Record<OfficeAgent["status"], number>>(
    (acc, agent) => {
      acc[agent.status] = (acc[agent.status] ?? 0) + 1;
      return acc;
    },
    { active: 0, paused: 0, idle: 0, error: 0 },
  );

  const entries = STATUS_ORDER.map((status) => [status, counts[status]] as const).filter(
    ([, count]) => count > 0,
  );

  if (entries.length === 0) return null;

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1 z-10">
      {entries.map(([status, count]) => (
        <span
          key={status}
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`}
        >
          {count} {STATUS_LABELS[status]}
        </span>
      ))}
    </div>
  );
}
