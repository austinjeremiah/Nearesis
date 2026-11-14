import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { serverTransport } from '@/lib/api/server';
import { requestJson } from '@/lib/api/transport';
import { ApiRequestError } from '@/lib/api/errors';
import { settle } from '@/lib/api/guard';
import ReportView from '@/components/report/report-view';
import type { ReportDoc } from '@/lib/report/types';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Nearesis workspace report', robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/w/<id>/report`: the whole workspace as a print-designed A4 document. Server-rendered from
 * `GET /v1/workspaces/:id/report`; the charts are drawn in the browser, and the root carries `data-report-ready="true"`
 * once every chart is drawn (the PDF renderer waits for it). A foreign or unknown workspace is the usual 404.
 */
export default async function ReportPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  if (!UUID.test(wid)) notFound();
  const r = await settle(requestJson<ReportDoc>(serverTransport, `/v1/workspaces/${encodeURIComponent(wid)}/report`));
  if (!r.ok) {
    if (r.error.kind === 'not_found') notFound();
    const e: ApiRequestError = r.error;
    return (
      <main className="rp-error" data-report-error={e.reasonCode ?? e.errorCode}>
        <h1>The report could not be built</h1>
        <p>{e.message}</p>
        <p className="rp-mono">{e.reasonCode ?? e.errorCode}</p>
      </main>
    );
  }
  return <ReportView doc={r.data} />;
}
