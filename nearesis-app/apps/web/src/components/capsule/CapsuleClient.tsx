"use client";
import dynamic from "next/dynamic";

const CapsuleViewer = dynamic(() => import("./CapsuleViewer.tsx").then((m) => m.CapsuleViewer), {
  ssr: false,
  loading: () => (
    <div className="nz-state" role="status" aria-busy="true">
      Loading capsule…
    </div>
  ),
});

export function CapsuleClient({ workspaceId }: { workspaceId: string }) {
  return <CapsuleViewer workspaceId={workspaceId} />;
}
