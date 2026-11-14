import type { ReactNode } from 'react';
import { Disclose } from '@/components/nx/flow/flow';
import { parseMarkdown, type Block, type Inline } from '@/lib/thesis-track/markdown';

/** A provenance pointer such as [results/estimates.json#/a/b] is shown as a small marker; the full pointer is its tooltip. */
const REF = /\[((?:results|raw|sql|build)\/[^\]\s]+)\]|\[(\d{1,3})\]/g;
function withRefs(text: string, key: number, refs: string[] | undefined): ReactNode {
  if (!text.includes('[')) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    const at = m.index ?? 0;
    // A numbered marker is a citation only when the section carries references; otherwise it is plain text.
    if (m[2] !== undefined && !refs?.length) continue;
    if (at > last) out.push(text.slice(last, at));
    if (m[2] !== undefined) {
      const n = Number(m[2]);
      const pointer = refs![n - 1];
      out.push(
        <sup key={`${key}-${at}`} className="tt-cite" title={pointer ?? 'Source not listed'} data-testid="cite">
          {n}
        </sup>,
      );
      last = at + m[0].length;
      continue;
    }
    const file = m[1]!.split('#')[0]!.split('/').pop();
    out.push(
      <code key={`${key}-${at}`} className="tt-ref" title={m[1]}>
        [{file}]
      </code>,
    );
    last = at + m[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return <span key={key}>{out}</span>;
}

function inline(nodes: Inline[], refs?: string[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return withRefs(n.v, i, refs);
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'strong':
        return <strong key={i}>{inline(n.c, refs)}</strong>;
      case 'em':
        return <em key={i}>{inline(n.c, refs)}</em>;
      case 'link': {
        const external = /^https?:/i.test(n.href);
        return (
          <a key={i} href={n.href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
            {inline(n.c)}
          </a>
        );
      }
    }
  });
}

function block(b: Block, i: number, base: number, refs?: string[]): ReactNode {
  switch (b.t) {
    case 'heading': {
      const level = Math.min(6, Math.max(base, b.level + base - 1));
      const Tag = `h${level}` as 'h4';
      return <Tag key={i}>{inline(b.c, refs)}</Tag>;
    }
    case 'p':
      return <p key={i}>{inline(b.c, refs)}</p>;
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return (
        <Tag key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it, refs)}</li>
          ))}
        </Tag>
      );
    }
    case 'table':
      return (
        <div key={i} className="tt-md-table table-wrap" tabIndex={0} role="region" aria-label="Table">
          <table className="table">
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} scope="col">{inline(c, refs)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{inline(c, refs)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return (
        <pre key={i} className="tt-code" tabIndex={0}>
          <code>{b.v}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={i}>{b.c.map((c, j) => block(c, j, base, refs))}</blockquote>;
    case 'hr':
      return <hr key={i} />;
  }
}

/** Renders section markdown as React elements. `headingBase` is the level a top-level `#` becomes. */
export default function MarkdownView({ markdown, headingBase = 4, references, openSources = false }: { markdown: string; headingBase?: number; references?: string[]; openSources?: boolean }) {
  const refs = references && references.length ? references : undefined;
  return (
    <>
      <div className="tt-md">{parseMarkdown(markdown).map((b, i) => block(b, i, headingBase, refs))}</div>
      {refs && <Sources refs={refs} open={openSources} />}
    </>
  );
}

/** The pointers behind the numbered markers, collapsed: "Sources (n)". */
export function Sources({ refs, open = false }: { refs: string[]; open?: boolean }) {
  return (
    <Disclose label={`Sources (${refs.length})`} openLabel={`Hide sources (${refs.length})`} defaultOpen={open}>
      <ol className="tt-sources" data-testid="sources">
        {refs.map((r, i) => (
          <li key={i}>
            <span className="tt-sn" aria-hidden="true">{i + 1}</span>
            <code className="tt-ref">{r}</code>
          </li>
        ))}
      </ol>
    </Disclose>
  );
}
