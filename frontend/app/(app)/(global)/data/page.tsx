import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import DataOverview from '@/components/nx/data/overview-view';
import { MetricCatalogue } from '@/components/nx/data/metrics-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Explore data" description="Live dashboards over the platform's sources, then the metric catalogue and authoring. Certified metrics can back published claims; everything else is exploratory." />
      <Content>
        <DataNav />
        <DataOverview />
        <MetricCatalogue />
      </Content>
    </>
  );
}
