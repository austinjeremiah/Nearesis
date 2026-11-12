import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import { MetricDetail } from '@/components/nx/data/metrics-view';

export default async function Page({ params, searchParams }: { params: Promise<{ metricId: string }>; searchParams: Promise<{ w?: string }> }) {
  const { metricId } = await params;
  const { w } = await searchParams;
  const key = decodeURIComponent(metricId);
  return (
    <>
      <PageHeader title="Metric" description="Definition, versions, validation, certification and audit trail." crumbs={[{ label: 'Data', href: '/data' }, { label: key }]} />
      <Content>
        <DataNav />
        <MetricDetail metricKey={key} wid={w ?? null} />
      </Content>
    </>
  );
}
