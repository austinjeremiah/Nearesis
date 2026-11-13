'use client';

import { useState } from 'react';
import { Badge } from '@/components/nx/evidence';

async function sha256Hex(buf: ArrayBuffer) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public documents come through the cookie-less BFF route and are hash-checked in the browser. */
export function ExportLinks({ id, docs }: { id: string; docs: { path: string; sha256: string; url: string }[] }) {
  const [res, setRes] = useState<Record<string, string>>({});
  const byPath = new Map(docs.map((d) => [d.path, d.url]));
  // The API's document url is /v1/public/...; the browser reads it through the cookie-less BFF mirror.
  const href = (p: string) => (byPath.get(p) ?? `/v1/public/publications/${encodeURIComponent(id)}/${p}`).replace(/^\/v1\/public\//, '/api/public/');
  async function check(p: string, sha: string) {
    try {
      const r = await fetch(href(p), { credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const actual = await sha256Hex(await r.arrayBuffer());
      setRes((s) => ({ ...s, [p]: actual === sha ? 'ok' : 'mismatch' }));
    } catch (e) {
      setRes((s) => ({ ...s, [p]: e instanceof Error ? e.message : 'failed' }));
    }
  }
  return (
    <ul className="col gap2" style={{ listStyle: 'none', padding: 0 }} data-testid="public-documents">
      {docs.map((d) => (
        <li key={d.path} className="row gap2" data-testid="public-document">
          <a className="link" href={href(d.path)} target="_blank" rel="noreferrer">{d.path}</a>
          <span className="mono tiny dim" title={d.sha256}>{d.sha256.slice(0, 12)}</span>
          <button type="button" className="btn ghost" data-testid="public-doc-check" onClick={() => void check(d.path, d.sha256)}>Verify download hash</button>
          {res[d.path] && <Badge tone={res[d.path] === 'ok' ? 'ok' : 'bad'}>{res[d.path] === 'ok' ? 'hash matches' : res[d.path]}</Badge>}
        </li>
      ))}
    </ul>
  );
}
