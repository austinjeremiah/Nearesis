"use client";
import dynamic from "next/dynamic";

/**
 * The workspace is browser-only (canvas, SSE, local storage). Rendering it on the client keeps every style a CSSOM
 * write, so the strict CSP (no inline style attributes in served HTML) holds without loosening it.
 */
const Workspace = dynamic(() => import("./Workspace.tsx").then((m) => m.Workspace), {
  ssr: false,
  loading: () => (
    <div className="nz-state" role="status" aria-busy="true">
      Loading workspace…
    </div>
  ),
});

export function WorkspaceClient({ workspaceId }: { workspaceId: string }) {
  return <Workspace workspaceId={workspaceId} />;
}
