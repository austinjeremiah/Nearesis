/** Browser side of "Sign in (dev)": the same-origin BFF route exchanges the seeded subject for the session cookie. */
export const DEV_SUBJECT = "dev-owner";

export async function devLoginAvailable(): Promise<boolean> {
  try {
    const r = await fetch("/api/dev/login", { cache: "no-store" });
    return r.ok && ((await r.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    return false;
  }
}

export async function signInDev(): Promise<boolean> {
  const r = await fetch("/api/dev/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: DEV_SUBJECT }),
  });
  return r.ok;
}

export interface WorkspaceRow {
  id: string;
  objective: string;
}

export async function listWorkspaces(): Promise<WorkspaceRow[]> {
  try {
    const r = await fetch("/api/k/workspaces", { cache: "no-store" });
    if (!r.ok) return [];
    return ((await r.json()) as { workspaces?: WorkspaceRow[] }).workspaces ?? [];
  } catch {
    return [];
  }
}

/** Kernel-backed workspace URL on the semantic layer (the default for signed-in users). Keeps the Fixture/Live choice. */
export function kernelWorkspaceUrl(id: string, source: "fixture" | "live" = "fixture"): string {
  return `/w/${id}?backend=kernel&data=semantic${source === "live" ? "&source=live" : ""}`;
}
