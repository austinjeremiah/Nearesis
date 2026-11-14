import type { ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '@/lib/thesis-track/markdown';

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'strong':
        return <strong key={i}>{inline(n.c)}</strong>;
      case 'em':
        return <em key={i}>{inline(n.c)}</em>;
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

function block(b: Block, i: number, base: number): ReactNode {
  switch (b.t) {
    case 'heading': {
      const level = Math.min(6, Math.max(base, b.level + base - 1));
      const Tag = `h${level}` as 'h4';
      return <Tag key={i}>{inline(b.c)}</Tag>;
    }
    case 'p':
      return <p key={i}>{inline(b.c)}</p>;
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return (
        <Tag key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
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
                  <th key={j} scope="col">{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{inline(c)}</td>
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
      return <blockquote key={i}>{b.c.map((c, j) => block(c, j, base))}</blockquote>;
    case 'hr':
      return <hr key={i} />;
  }
}

/** Renders section markdown as React elements. `headingBase` is the level a top-level `#` becomes. */
export default function MarkdownView({ markdown, headingBase = 4 }: { markdown: string; headingBase?: number }) {
  return <div className="tt-md">{parseMarkdown(markdown).map((b, i) => block(b, i, headingBase))}</div>;
}
