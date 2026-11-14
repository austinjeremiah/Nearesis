"use client";
import dynamic from "next/dynamic";

/** Client-only render keeps every style a CSSOM write, so the strict CSP holds. */
const EvidenceExplorer = dynamic(() => import("./EvidenceExplorer.tsx").then((m) => m.EvidenceExplorer), {
  ssr: false,
  loading: () => (
    <div className="nz-state" role="status" aria-busy="true">
      Loading evidence graph…
    </div>
  ),
});

export function EvidenceClient({ workspaceId }: { workspaceId: string }) {
  return <EvidenceExplorer workspaceId={workspaceId} />;
}
