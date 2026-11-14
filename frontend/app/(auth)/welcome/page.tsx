import type { Metadata } from 'next';
import Wordmark from '@/components/Wordmark';
import { LinkButton } from '@/components/nx/ui';

export const metadata: Metadata = { title: 'Welcome · Nearesis' };

/**
 * Spec 5.1 — first run.
 *
 * Three short blocks: Ask, Investigate, Verify.
 */
const STEPS = [
  {
    n: '1',
    title: 'Ask',
    body: 'Open a workspace around exactly one question, pick the sources it may read and set a spending cap. A director decomposes it into certified queries before anything runs.',
  },
  {
    n: '2',
    title: 'Investigate',
    body: 'Agents return typed panels, never arbitrary code. Highlight a stretch of a chart and that exact selection becomes a marker you can hand to a skeptic or a quant.',
  },
  {
    n: '3',
    title: 'Verify',
    body: 'Publish a claim table with counterevidence and a falsification condition, plus a capsule that rebuilds every chart offline without your credentials.',
  },
];

export default function WelcomePage() {
  return (
    <>
      <div className="auth-panel">
        <><span className="wm-on-light"><Wordmark tone="black" size={30} /></span><span className="wm-on-dark"><Wordmark tone="white" size={30} /></span></>
        <div className="col gap2">
          <h1 className="h1">Three steps, one rebuildable answer</h1>
          <p className="muted">
            Nearesis is a living-thesis workspace for NEAR research, not a dashboard gallery and
            not a chat box over SQL.
          </p>
        </div>

        <div className="auth-steps">
          {STEPS.map((s) => (
            <div className="auth-step" key={s.n}>
              <span className="n">{s.n}</span>
              <div className="col gap1">
                <span className="h3">{s.title}</span>
                <p className="small muted">{s.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="row gap2 wrap">
          <LinkButton href="/workspaces/new" variant="primary" size="lg">
            Create a workspace
          </LinkButton>
          <LinkButton href="/workspaces" size="lg">
            Open my workspaces
          </LinkButton>
          <LinkButton href="/publications" size="lg">
            Explore published research
          </LinkButton>
        </div>
      </div>

      <aside className="auth-aside">
        <span className="label" style={{ color: 'var(--text-on-dark-2)' }}>
          The rule
        </span>
        <p className="claim">
          A null result<br />
          <span className="hl">still passes.</span>
        </p>
        <p className="small" style={{ color: 'var(--text-on-dark-2)', maxWidth: '46ch' }}>
          Success is not that the thesis is confirmed. Success is that the same snapshot, commit
          and metric versions produce the same tables, and that we say so plainly when the answer
          is mixed, unsupported or simply not yet decidable.
        </p>
      </aside>
    </>
  );
}
