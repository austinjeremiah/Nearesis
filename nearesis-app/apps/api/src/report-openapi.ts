import type { RouteSpec } from "@nearesis/contracts";

/** Route table of the workspace report (apps/api/src/report-routes.ts). Spread into ROUTES by openapi-routes.ts. */
export const REPORT_ROUTES: RouteSpec[] = [
  {
    method: "get",
    path: "/v1/workspaces/:id/report",
    tag: "workspaces",
    summary:
      "Workspace report as one JSON document: newest 20 runs with findings, each panel's data, hypotheses, markers, monitors, capsules with proofs and publication, costs and limitations (any member; unknown and foreign ids are one 404)",
    auth: "bearer",
    responses: {
      "200": {
        description:
          "Report document { generatedAt, workspace, runs, panels, hypotheses, markers, monitors, capsules, costs, limitations }; a part that cannot be read is empty and named in limitations, unknown values are null",
        untyped: true,
      },
    },
  },
];
