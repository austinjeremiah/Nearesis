/** Structured validation issue. `code` is a stable rule/error code; the kernel maps a non-empty list to HTTP 422. */
export interface Issue {
  code: IssueCode;
  path: string;
  message: string;
  opIndex?: number;
  suggestion?: string;
}

export type IssueCode =
  // structural (C02, C09)
  | "NOT_AN_OBJECT"
  | "EXECUTABLE_CONTENT"
  | "SCHEMA_INVALID"
  | "UNKNOWN_PANEL_KIND"
  | "UNKNOWN_PROPERTY"
  | "SCHEMA_VERSION_UNSUPPORTED"
  // binding (C09, C14)
  | "ENCODING_FIELD_UNKNOWN"
  | "FIELD_NOT_IN_RESULT"
  | "UNIT_MISSING"
  | "QUERY_UNRESOLVED"
  // chart semantics (C03, C17)
  | "UNIT_MISMATCH"
  | "SHARE_DENOMINATOR_MISSING"
  | "SHARE_OVERLAPPING_SEGMENTS"
  | "DUAL_AXIS_UNDISCLOSED"
  | "QUOTE_TIME_AXIS"
  | "PERIOD_UNIQUE_SUM_REFUSED"
  | "LOG_AXIS_NONPOSITIVE"
  | "GAP_INTERPOLATION_REFUSED"
  | "KIND_ENCODING_INVALID"
  // patch (C05, C11)
  | "DUPLICATE_PANEL_ID"
  | "PANEL_NOT_FOUND"
  | "PANEL_HAS_DEPENDENTS"
  | "DUPLICATE_MARKER_ID"
  | "MARKER_NOT_FOUND"
  | "MARKER_ANCHOR_INVALID"
  | "SELECTION_MISMATCH"
  | "STALE_REVISION"
  | "PANEL_LIMIT";

export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export function zodIssues(
  error: { issues: Array<{ code: string; path: PropertyKey[]; message: string; keys?: string[] }> },
  prefix = "",
): Issue[] {
  return error.issues.map((i) => {
    const path = [prefix, ...i.path.map(String)].filter(Boolean).join(".");
    if (i.code === "unrecognized_keys")
      return {
        code: "UNKNOWN_PROPERTY" as const,
        path,
        message: `unknown properties: ${(i.keys ?? []).join(", ")}`,
      };
    if (path.endsWith("kind") && i.code === "invalid_value")
      return { code: "UNKNOWN_PANEL_KIND" as const, path, message: "panel kind is not registered" };
    if (path.endsWith("schemaVersion"))
      return { code: "SCHEMA_VERSION_UNSUPPORTED" as const, path, message: i.message };
    return { code: "SCHEMA_INVALID" as const, path, message: i.message };
  });
}
