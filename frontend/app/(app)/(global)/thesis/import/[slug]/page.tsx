import { Content } from '@/components/nx/shell';
import ImportThesis from '@/components/nx/thesis/import-thesis';

export const metadata = { title: 'Open thesis' };

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <Content>
      <ImportThesis slug={decodeURIComponent(slug)} />
    </Content>
  );
}
