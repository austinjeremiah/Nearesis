'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/nx/overlays';
import { MarkerCreateForm } from '@/components/nx/marker-create';
import { Button } from '@/components/nx/ui';
import { draftMarkerFromSelection, panelSelection, selectionActions, type PanelSelection } from '@/lib/panel/selection';

function CreateMarkerAction({ sel }: { sel: PanelSelection }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const draft = draftMarkerFromSelection(sel);
  const start = draft.anchor.kind === 'time_range' ? draft.anchor.start : draft.anchor.at;
  const end = draft.anchor.kind === 'time_range' ? draft.anchor.end : draft.anchor.at;
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} data-testid="selection-create-marker">
        Create marker
      </Button>
      <Modal
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v && created) panelSelection.clear();
        }}
        title="Create a marker from this selection"
        description="The marker is anchored to the selected range. Nothing runs until you assign an agent."
        wide
      >
        {created ? (
          <div className="col gap2" data-testid="marker-created">
            <p className="small">Marker created. It is drawn on the chart and listed under Markers.</p>
            <div className="row gap2">
              <Link href={`/w/${sel.workspaceId}/markers/${created}`} className="btn primary" data-testid="marker-created-link">
                Open marker
              </Link>
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  panelSelection.clear();
                }}
              >
                Close
              </Button>
            </div>
          </div>
        ) : (
          <MarkerCreateForm wid={sel.workspaceId} selection={{ panelId: draft.panelId, start, end, sourceWatermark: sel.sourceWatermark }} onCreated={setCreated} />
        )}
      </Modal>
    </>
  );
}

/** Mount once on a page that shows a SelectionBar: adds "Create marker" to the selection actions. */
export function MarkerSelectionAction() {
  useEffect(() => selectionActions.register((sel) => <CreateMarkerAction sel={sel} />), []);
  return null;
}
