"use client";
import dynamic from "next/dynamic";

/** Client-only render keeps every style a CSSOM write, so the strict CSP holds. */
const CollabBoard = dynamic(() => import("./CollabBoard.tsx").then((m) => m.CollabBoard), {
  ssr: false,
  loading: () => (
    <div className="nz-state" role="status" aria-busy="true">
      Loading shared layout…
    </div>
  ),
});

export function CollabClient({ workspaceId }: { workspaceId: string }) {
  return <CollabBoard workspaceId={workspaceId} />;
}
