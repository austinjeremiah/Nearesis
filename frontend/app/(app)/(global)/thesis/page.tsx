import { Content, PageHeader } from '@/components/nx/shell';
import ThesisView from '@/components/nx/thesis-track/thesis-view';

export const metadata = { title: 'NEAR Thesis' };

export default function Page() {
  return (
    <>
      <PageHeader
        title="NEAR Thesis"
        description="Is cross-chain volume through NEAR Intents a better leading indicator of real network usage than token price? The verdict, the evidence on both sides, and the queries behind every chart."
        crumbs={[{ label: 'Home', href: '/home' }, { label: 'NEAR Thesis' }]}
      />
      <Content>
        <ThesisView />
      </Content>
    </>
  );
}
