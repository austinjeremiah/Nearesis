/** Query keys for panel data. Under the workspace scope so a reload invalidates them, but not under `canvas`, so a canvas event does not refetch every panel. */
export const panelKeys = {
  data: (wid: string, hash: string, source?: string) => ['ws', wid, 'panel-data', hash, source ?? ''] as const,
  allData: (wid: string) => ['ws', wid, 'panel-data'] as const,
  lenses: (wid: string) => ['ws', wid, 'lenses'] as const,
  lensRes: (wid: string, lid: string) => ['ws', wid, 'lenses', lid, 'resolution'] as const,
  workspace: (wid: string) => ['workspace', wid] as const,
};
