"use client";
import dynamic from "next/dynamic";

const HistoryView = dynamic(() => import("./HistoryView.tsx").then((m) => m.HistoryView), {
  ssr: false,
  loading: () => (
    <div className="nz-state" role="status" aria-busy="true">
      Loading time machine…
    </div>
  ),
});

export function HistoryClient({ workspaceId }: { workspaceId: string }) {
  return <HistoryView workspaceId={workspaceId} />;
}
