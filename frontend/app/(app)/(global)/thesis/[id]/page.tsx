import { Content, PageHeader } from '@/components/nx/shell';
import ThesisPage from '@/components/nx/thesis/thesis-page';

export const metadata = { title: 'Thesis' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PageHeader
        title="Thesis"
        description="The verdict, the evidence on both sides, and the query behind every chart."
        crumbs={[{ label: 'Home', href: '/home' }, { label: 'Theses', href: '/thesis' }, { label: 'Thesis' }]}
      />
      <Content>
        <ThesisPage id={decodeURIComponent(id)} />
      </Content>
    </>
  );
}
