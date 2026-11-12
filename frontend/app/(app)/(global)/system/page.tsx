import { Content, PageHeader } from '@/components/nx/shell';
import SystemView from './system-view';

export default function Page() {
  return (
    <>
      <PageHeader title="System health" description="Source freshness and coverage, service objectives and the global model-spend ceiling." />
      <Content>
        <SystemView />
      </Content>
    </>
  );
}
