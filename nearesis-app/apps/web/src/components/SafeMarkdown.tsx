"use client";
import { type Block, type Inline, parseSafeMarkdown } from "@nearesis/canvas-schema";
import { Fragment, type ReactNode, useMemo } from "react";

/** Renders the safe markdown AST as React text nodes. No innerHTML anywhere (C10e). */
function inline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.v}</Fragment>;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "em":
        return <em key={i}>{inline(n.c)}</em>;
      case "strong":
        return <strong key={i}>{inline(n.c)}</strong>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {inline(n.c)}
          </a>
        );
    }
  });
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "h":
      return b.level === 1 ? <h3 key={i}>{inline(b.c)}</h3> : <h4 key={i}>{inline(b.c)}</h4>;
    case "p":
      return <p key={i}>{inline(b.c)}</p>;
    case "ul":
      return (
        <ul key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ol>
      );
    case "pre":
      return <pre key={i}>{b.v}</pre>;
  }
}

export function SafeMarkdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseSafeMarkdown(source), [source]);
  return <div className="markdown">{blocks.map(block)}</div>;
}
