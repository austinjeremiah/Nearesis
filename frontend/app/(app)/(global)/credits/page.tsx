import type { Metadata } from 'next';
import { Content, PageHeader } from '@/components/nx/shell';
import CreditsView from './credits-view';

export const metadata: Metadata = { title: 'Credits · Nearesis' };

export default function Page() {
  return (
    <>
      <PageHeader title="Credits" description="NEAR testnet credits that pay for OutLayer proofs: what you hold, what is reserved, and every change." />
      <Content>
        <CreditsView />
      </Content>
    </>
  );
}
