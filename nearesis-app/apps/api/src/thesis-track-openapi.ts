import type { RouteSpec } from "@nearesis/contracts";

/** Route table of the NEAR thesis track bundle (apps/api/src/thesis-track-routes.ts). Spread into ROUTES by openapi-routes.ts. */
export const THESIS_TRACK_ROUTES: RouteSpec[] = [
  {
    method: "get",
    path: "/v1/thesis",
    tag: "thesis-track",
    summary:
      "The NEAR thesis track bundle (thesis/build/thesis.json, served byte for byte; any signed-in user; 503 THESIS_NOT_BUILT when it has not been built)",
    auth: "bearer",
    responses: {
      "200": {
        description:
          "nearesis.thesis.v1 document: verdict, sections, claims, charts, tables, sampleQuery, unableToCompute, reproduce, files",
        untyped: true,
      },
    },
  },
  {
    method: "get",
    path: "/v1/thesis/files/*",
    tag: "thesis-track",
    summary:
      "An allowlisted file of the thesis bundle: build/THESIS.md, build/site/index.html, build/thesis.json, build/HASHES.json, raw/*.json, sql/{executed,bigquery}/*.sql, TABLES.md (any signed-in user; HTML is served sandboxed)",
    auth: "bearer",
    responses: {
      "200": { description: "File bytes with the matching content type and nosniff", untyped: true },
    },
  },
];
