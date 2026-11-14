'use client';

import { useState } from 'react';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { Card, Skeleton } from '@/components/nx/ui';
import { TabStrip } from '@/components/nx/landing';
import { useCanvas, usePanelData, usePanelProgress } from '@/lib/panel/hooks';
import type { Viz } from '@/lib/panel/model';
import { DataTable } from './ChartRenderer';
import { PanelBody, PanelFrame } from './PanelFrame';
import { ProvenanceBlock, QueryBlock } from './Provenance';
import { MarkerSelectionAction } from '@/components/nx/marker-selection-action';
import { SharedNotes } from '@/components/nx/shared-notes';
import { RangeSelectForm, SelectionBar } from './Selection';
import './panel.css';

type Tab = 'data' | 'query' | 'provenance';

/** Full view of one panel: the chart with range selection, then Data, Query and Provenance tabs. */
export default function PanelDetail({ wid, panelId }: { wid: string; panelId: string }) {
  const canvas = useCanvas(wid);
  const progress = usePanelProgress(wid);
  const panel = canvas.data?.panels.find((p) => p.panelId === panelId);
  const data = usePanelData(wid, panel?.queryRef?.hash, !!panel);
  const [tab, setTab] = useState<Tab>('data');
  const [viz, setViz] = useState<Viz | undefined>(undefined);

  if (canvas.isPending) return <Skeleton rows={6} />;
  if (canvas.isError) return <ApiErrorState error={canvas.error} onRetry={() => canvas.refetch()} />;
  if (!panel)
    return (
      <Card title="Panel not found">
        <p className="small">No panel with this id is on the canvas. It may have been removed in a later revision.</p>
      </Card>
    );
  const d = data.data;
  const timeBased = panel.kind === 'timeSeries' || panel.kind === 'bar';
  return (
    <div className="col gap3">
      <MarkerSelectionAction />
      <SelectionBar wid={wid} titles={{ [panel.panelId]: panel.title }} />
      <PanelFrame wid={wid} panel={panel} heading viz={viz} onViz={setViz}>
        <PanelBody wid={wid} panel={panel} height={380} progress={progress[panel.panelId]} markers={canvas.data?.markers} brush={timeBased} />
      </PanelFrame>
      <SharedNotes wid={wid} panelId={panel.panelId} />
      {d && d.chart && timeBased && (
        <Card title="Select a range" subtitle="Drag on the chart, or enter dates here. Selecting writes nothing and starts no agent.">
          <RangeSelectForm wid={wid} panel={panel} data={d} />
        </Card>
      )}
      <TabStrip
        ariaLabel="Panel details"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'data', label: 'Data' },
          { value: 'query', label: 'Query' },
          { value: 'provenance', label: 'Provenance' },
        ]}
      />
      <div role="tabpanel" aria-label={tab}>
        {data.isPending ? (
          <Skeleton rows={4} />
        ) : data.isError ? (
          <ApiErrorState error={data.error} onRetry={() => data.refetch()} />
        ) : !d ? null : tab === 'data' ? (
          d.chart ? (
            <>
              <div className="row gap2" style={{ marginBottom: 8 }}>
                <Badge outline>{d.chart.rows.length.toLocaleString('en-US')} rows</Badge>
                <Badge outline>data revision {d.chart.dataRevision}</Badge>
              </div>
              <DataTable data={d} limit={1000} />
            </>
          ) : (
            <p className="small">No data: {d.cannotCompute?.explanation ?? 'the source cannot answer.'}</p>
          )
        ) : tab === 'query' ? (
          <QueryBlock panel={panel} data={d} />
        ) : (
          <ProvenanceBlock panel={panel} data={d} />
        )}
      </div>
    </div>
  );
}
