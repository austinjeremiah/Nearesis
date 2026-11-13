'use client';

import { Suspense, useCallback, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Tabs } from '@/components/nx/ui';
import AgentTab from '@/components/nx/agent/agent-tab';

type Tab = 'overview' | 'agent';

/**
 * Home tabs. The tab is in the URL (`/home?tab=agent`). Both panels stay mounted and the inactive one is hidden, so a
 * pipeline running in the Agent tab keeps going while Overview is open. `q` carries a question from the hero box.
 */
function Inner({ overview }: { overview: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab: Tab = sp.get('tab') === 'agent' ? 'agent' : 'overview';
  const q = sp.get('q');
  // Mount the agent panel on first visit and keep it from then on.
  const [visited, setVisited] = useState(tab === 'agent');
  if (tab === 'agent' && !visited) setVisited(true);

  const go = (t: Tab) => router.replace(t === 'agent' ? `${pathname}?tab=agent` : pathname, { scroll: false });
  const consumed = useCallback(() => router.replace(`${pathname}?tab=agent`, { scroll: false }), [router, pathname]);

  return (
    <>
      <div className="home-tabs-bar">
        <Tabs
          ariaLabel="Home sections"
          value={tab}
          onChange={go}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'agent', label: 'Agent' },
          ]}
        />
      </div>
      <div role="tabpanel" aria-label="Overview" hidden={tab !== 'overview'} data-testid="home-panel-overview">
        {overview}
      </div>
      <div role="tabpanel" aria-label="Agent" hidden={tab !== 'agent'} data-testid="home-panel-agent">
        {visited && <AgentTab active={tab === 'agent'} initialQuestion={q} onQuestionConsumed={consumed} />}
      </div>
    </>
  );
}

export default function HomeTabs({ overview }: { overview: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <Inner overview={overview} />
    </Suspense>
  );
}
