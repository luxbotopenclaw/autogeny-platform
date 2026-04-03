// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock R3F before any imports that reference it
vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="r3f-canvas">{children}</div>
  ),
  useFrame: vi.fn(),
}));

vi.mock("@react-three/drei", () => ({
  OrbitControls: () => null,
  Environment: () => null,
  Html: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock OfficeCanvas (lazy-imported by OfficePage)
vi.mock("../components/office/OfficeCanvas", () => ({
  OfficeCanvas: ({ agents }: { agents: { id: string }[] }) => (
    <div data-testid="office-canvas" data-agent-count={agents.length} />
  ),
}));

// Mock router
vi.mock("@/lib/router", () => ({
  Link: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useLocation: () => ({ pathname: "/test" }),
}));

// Mock contexts
vi.mock("../context/CompanyContext", () => ({
  useCompany: vi.fn(() => ({ selectedCompanyId: "company-1" })),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: vi.fn(() => ({ setBreadcrumbs: vi.fn() })),
}));

// Mock office API
vi.mock("../api/office", () => ({
  officeApi: { getLayout: vi.fn() },
  officeKeys: { layout: (id: string) => ["office", "layout", id] },
}));

import { useCompany } from "../context/CompanyContext";
import { officeApi } from "../api/office";
import type { OfficeLayout } from "../api/office";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="suspense-fallback" />}>{children}</Suspense>
    </QueryClientProvider>
  );
}

describe("OfficePage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    vi.mocked(useCompany).mockReturnValue({ selectedCompanyId: "company-1" } as ReturnType<
      typeof useCompany
    >);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows empty state when agents array is empty", async () => {
    vi.mocked(officeApi.getLayout).mockResolvedValue({
      agents: [],
      gridSize: { rows: 0, cols: 0 },
    } as OfficeLayout);

    const { default: OfficePage } = await import("./OfficePage");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Wrapper>
          <OfficePage />
        </Wrapper>,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.textContent).toMatch(/No agents/i);

    act(() => root.unmount());
  });

  it("shows error message when query fails", async () => {
    vi.mocked(officeApi.getLayout).mockRejectedValue(new Error("Network error"));

    const { default: OfficePage } = await import("./OfficePage");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Wrapper>
          <OfficePage />
        </Wrapper>,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.textContent).toMatch(/Network error/i);

    act(() => root.unmount());
  });

  it("does not fetch when no company is selected", async () => {
    vi.mocked(useCompany).mockReturnValue({ selectedCompanyId: null } as ReturnType<
      typeof useCompany
    >);

    const { default: OfficePage } = await import("./OfficePage");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Wrapper>
          <OfficePage />
        </Wrapper>,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(officeApi.getLayout).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
