import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { officeApi, officeKeys } from "../api/office";
import type { OfficeAgent } from "../api/office";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { AgentPresenceSummary } from "../components/office/AgentPresenceSummary";

const OfficeCanvas = lazy(() =>
  import("../components/office/OfficeCanvas").then((m) => ({ default: m.OfficeCanvas })),
);

export default function OfficePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedAgent, setSelectedAgent] = useState<OfficeAgent | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "3D Office" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: officeKeys.layout(selectedCompanyId ?? ""),
    queryFn: () => officeApi.getLayout(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load office layout"}
        </p>
      </div>
    );
  }

  if (!data?.agents.length) {
    return (
      <EmptyState
        icon={Building2}
        message="No agents in this company yet. Hire some agents to see them in the 3D office."
      />
    );
  }

  return (
    <div className="h-full w-full relative">
      <Suspense fallback={<PageSkeleton variant="org-chart" />}>
        <OfficeCanvas agents={data.agents} onAgentSelect={setSelectedAgent} />
      </Suspense>
      <AgentPresenceSummary agents={data.agents} />
      {selectedAgent && (
        <div className="absolute bottom-3 left-3 z-10 rounded-lg border border-border bg-card p-3 shadow-md min-w-[200px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">{selectedAgent.name}</span>
            <button
              onClick={() => setSelectedAgent(null)}
              className="text-muted-foreground hover:text-foreground text-xs leading-none"
              aria-label="Close agent panel"
            >
              ✕
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground capitalize">{selectedAgent.status}</p>
          {selectedAgent.currentTask && (
            <p className="mt-1 text-xs text-muted-foreground truncate">{selectedAgent.currentTask}</p>
          )}
        </div>
      )}
    </div>
  );
}
