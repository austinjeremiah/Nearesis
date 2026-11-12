'use client';

import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { KeyValues, Notice } from '@/components/nx/ui';
import { ApiCard, WindowControl, useWindow } from './kit';
import { SeriesChart } from './charts';
import { fInt, fPct, fDec, toNum } from '@/lib/data/num';

type Meta = { caveats: string[]; accountsArePeople: boolean; windowStart: string; headThreshold: number; newMeans: string };
type Cov = { requestedDays: number; daysWithData: number; missingDays: string[] };

function CoverageLine({ c }: { c: Cov }) {
  return (
    <p className="small dim">
      Coverage: {c.daysWithData} of {c.requestedDays} days{c.missingDays.length ? `, missing ${c.missingDays.join(', ')}` : ''}.
    </p>
  );
}

export default function AccountsView() {
  const { days, setDays } = useWindow(30);
  return (
    <div className="col gap3" data-testid="accounts-view">
      <Notice tone="info" title="Accounts are not people">
        One person can hold many accounts, and one account (a bot, relayer or game contract) can serve many people. "New" means the first organic transaction seen since the scan window start, not lifetime first-seen.
      </Notice>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <WindowControl days={days} onChange={setDays} options={[7, 14, 30, 90]} />
      </div>

      <ApiCard<{ coverage: Cov; daily: { date: string; activeAccounts: number; newAccounts: number; returningAccounts: number; newShare: number; isWindowStart: boolean }[]; meta: Meta }>
        id="daily" title="Daily active accounts, new versus returning" path="/v1/accounts/daily" query={{ days }} caveats={(d) => d.meta.caveats}
      >
        {(d) => {
          const ws = d.daily.find((x) => x.isWindowStart);
          const last = d.daily[d.daily.length - 1];
          return (
            <div className="col gap3">
              <SeriesChart ariaLabel="Daily active accounts" unit="accounts" series={[
                { name: 'new', points: d.daily.map((x) => ({ x: x.date, y: x.newAccounts })) },
                { name: 'returning', points: d.daily.map((x) => ({ x: x.date, y: x.returningAccounts })) },
              ]} kind="bar" />
              <p className="small" data-testid="window-start-caveat">
                Window-start caveat: the account scan starts on <span className="mono">{d.meta.windowStart}</span>. Early in the scan nearly every account looks new because nothing precedes it
                {ws ? `; ${ws.date} is the window start day and is not comparable` : ''}. {d.meta.newMeans}.
              </p>
              {last && <p className="small">Latest day {last.date}: {fInt(last.activeAccounts)} active, {fInt(last.newAccounts)} new ({fPct(last.newShare)}), {fInt(last.returningAccounts)} returning.</p>}
              <CoverageLine c={d.coverage} />
            </div>
          );
        }}
      </ApiCard>

      <ApiCard<{ current: { from: string; to: string }; previous: { from: string; to: string }; complete: boolean; averageDailyActiveAccounts: { current: number; previous: number }; averageDailyNewAccounts: { current: number; previous: number }; averageDailyReturningAccounts: { current: number; previous: number }; change: number; newAccountContribution: number; returningAccountContribution: number; note: string; meta: Meta }>
        id="growth" title="Growth: new versus returning contribution" path="/v1/accounts/growth" query={{ days }} caveats={(d) => d.meta.caveats}
      >
        {(d) => (
          <div className="col gap2">
            {!d.complete && <Notice tone="warn" title="Incomplete">One of the two windows has missing days. Averages are lower bounds.</Notice>}
            <KeyValues rows={[
              { k: 'Average daily active', v: <span className="mono">{fInt(d.averageDailyActiveAccounts.current)} (previous {fInt(d.averageDailyActiveAccounts.previous)})</span> },
              { k: 'Average daily new', v: <span className="mono">{fInt(d.averageDailyNewAccounts.current)} (previous {fInt(d.averageDailyNewAccounts.previous)})</span> },
              { k: 'Average daily returning', v: <span className="mono">{fInt(d.averageDailyReturningAccounts.current)} (previous {fInt(d.averageDailyReturningAccounts.previous)})</span> },
              { k: 'Change in average DAU', v: <span className="mono">{fInt(d.change)}</span> },
              { k: 'from new accounts', v: <span className="mono">{fInt(d.newAccountContribution)}</span> },
              { k: 'from returning accounts', v: <span className="mono">{fInt(d.returningAccountContribution)}</span> },
            ]} />
            <p className="small dim">{d.note} Windows {d.current.from}..{d.current.to} vs {d.previous.from}..{d.previous.to}.</p>
          </div>
        )}
      </ApiCard>

      <ApiCard<{ windowStart: string; cohorts: { cohortWeek: string; cohortSize: number; isWindowStartCohort: boolean; weeks: { weekOffset: number; accounts: number; rate: number; partialWeek: boolean }[] }[]; notes?: string[]; meta: Meta }>
        id="retention" title="Weekly cohort retention" path="/v1/accounts/retention" query={{ days: Math.max(days, 90) }} caveats={(d) => [...(d.notes ?? []), ...d.meta.caveats]}
      >
        {(d) => {
          const full = d.cohorts.filter((c) => !c.isWindowStartCohort).slice(-8);
          const maxOff = 8;
          return (
            <div className="col gap2">
              <p className="small">
                The first cohort ({d.windowStart}) is the whole pre-existing population, not new accounts, and is excluded from the table. Partial weeks are marked and are not final.
              </p>
              <DataTable
                caption="Retention rate by weeks since cohort week"
                rows={full}
                rowKey={(c) => c.cohortWeek}
                columns={[
                  { key: 'w', header: 'Cohort week', render: (c) => <span className="mono">{c.cohortWeek}</span> },
                  { key: 's', header: 'Size', numeric: true, render: (c) => fInt(c.cohortSize) },
                  ...Array.from({ length: maxOff + 1 }, (_, o) => ({
                    key: `w${o}`,
                    header: `W+${o}`,
                    numeric: true,
                    render: (c: { weeks: { weekOffset: number; rate: number; partialWeek: boolean }[] }) => {
                      const w = c.weeks.find((x) => x.weekOffset === o);
                      return w ? <span title={w.partialWeek ? 'Partial week' : undefined}>{fPct(w.rate, 0)}{w.partialWeek ? '*' : ''}</span> : <span className="dim">—</span>;
                    },
                  })),
                ]}
              />
            </div>
          );
        }}
      </ApiCard>

      <ApiCard<{ coverage: Cov; daily: { date: string; activeAccounts: number; top1PctShare: number; top5PctShare: number; top10AccountsShare: number; headAccounts: number; headShare: number; tailShare: number }[]; meta: Meta }>
        id="concentration" title="Activity concentration" path="/v1/accounts/concentration" query={{ days }} caveats={(d) => d.meta.caveats}
      >
        {(d) => (
          <div className="col gap2">
            <SeriesChart ariaLabel="Share of transactions" unit="share" series={[
              { name: 'top 1% accounts', points: d.daily.map((x) => ({ x: x.date, y: x.top1PctShare })) },
              { name: 'head accounts (100+ tx/day)', points: d.daily.map((x) => ({ x: x.date, y: x.headShare })) },
              { name: 'top 10 accounts', points: d.daily.map((x) => ({ x: x.date, y: x.top10AccountsShare })) },
            ]} />
            {d.daily.length > 0 && <p className="small">Latest day: top 1% of accounts hold {fPct(d.daily[d.daily.length - 1].top1PctShare)} of organic transactions; {fInt(d.daily[d.daily.length - 1].headAccounts)} head accounts hold {fPct(d.daily[d.daily.length - 1].headShare)}.</p>}
            <CoverageLine c={d.coverage} />
          </div>
        )}
      </ApiCard>

      <ApiCard<{ definition: string; headShareOfOrganicTransactions: number; accounts: { account: string; headDays: number; txOrganic: number; maxDayTx: number; shareOfOrganicTransactions: number; frequencyLabel: string }[]; caveat: string; meta: Meta }>
        id="highfreq" title="Highest-frequency accounts" path="/v1/accounts/high-frequency" query={{ days, limit: 20 }} caveats={(d) => [d.caveat]}
      >
        {(d) => (
          <div className="col gap2">
            <p className="small">{d.definition} Head accounts carry {fPct(d.headShareOfOrganicTransactions)} of organic transactions.</p>
            <DataTable caption="Accounts by organic transactions (frequency labels only, not identity)" rows={d.accounts} rowKey={(a) => a.account} columns={[
              { key: 'a', header: 'Account', render: (a) => <span className="mono">{a.account}</span> },
              { key: 'l', header: 'Label', render: (a) => <Badge outline title="Describes transaction frequency only; not proof of a bot, a person or any identity">{a.frequencyLabel.replace(/_/g, ' ')}</Badge> },
              { key: 'h', header: 'Head days', numeric: true, render: (a) => fInt(a.headDays) },
              { key: 't', header: 'Organic tx', numeric: true, render: (a) => fInt(a.txOrganic) },
              { key: 'm', header: 'Max day', numeric: true, render: (a) => fInt(a.maxDayTx) },
              { key: 's', header: 'Share', numeric: true, render: (a) => fPct(a.shareOfOrganicTransactions) },
            ]} />
          </div>
        )}
      </ApiCard>
    </div>
  );
}
