"use client";
import dynamic from "next/dynamic";

/** Client-only render keeps every style a CSSOM write, so the strict CSP holds. */
const ThesisDashboard = dynamic(() => import("./ThesisDashboard.tsx").then((m) => m.ThesisDashboard), {
  ssr: false,
  loading: () => (
    <div className="nz-state" role="status" aria-busy="true">
      Loading thesis…
    </div>
  ),
});

export function ThesisClient({ workspaceId }: { workspaceId: string }) {
  return <ThesisDashboard workspaceId={workspaceId} />;
}
