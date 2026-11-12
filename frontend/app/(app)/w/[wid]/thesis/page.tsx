import ThesisView from './thesis-view';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return <ThesisView wid={wid} />;
}
