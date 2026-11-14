export interface DataTableProps {
  columns: Array<{ name: string; unit: string | null }>;
  rows: Array<Array<string | number | null>>;
  limit?: number;
}

/** Exact values, tabular figures, sticky header. Missing is an em dash, never zero. Plain text only. */
export function DataTable({ columns, rows, limit = 500 }: DataTableProps) {
  return (
    <div className="nz-table-wrap">
      <table className="nz-table data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name} scope="col">
                {c.name}
                {c.unit ? ` (${c.unit})` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} data-num={typeof v === "number" ? "true" : undefined}>
                  {v === null ? "—" : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
