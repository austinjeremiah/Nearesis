import type { Metadata } from 'next';
import { Content, PageHeader } from '@/components/nx/shell';
import CreditsView from './credits-view';

export const metadata: Metadata = { title: 'Credits · Nearesis' };

export default function Page() {
  return (
    <>
      <PageHeader title="Credits" description="Your USD allowance for AI calls and OutLayer proofs: what is left, what is reserved, and every change." />
      <Content>
        <CreditsView />
      </Content>
    </>
  );
}
