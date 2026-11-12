import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import { MetricCatalogue } from '@/components/nx/data/metrics-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Explore data" description="Metric catalogue and authoring. Certified metrics can back published claims; everything else is exploratory." />
      <Content>
        <DataNav />
        <MetricCatalogue />
      </Content>
    </>
  );
}
