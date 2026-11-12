'use client';
import { Activity } from 'lucide-react';
import { useEvents } from '@/lib/events';

export function Feed() {
  const { recent } = useEvents();
  return (
    <div className="card col">
      <span className="eyebrow"><Activity size={12} /> Live events (SSE)</span>
      <div className="feed timeline">
        {recent.slice(0, 25).map((e, i) => (
          <div className="ev" key={`${e.at}:${i}`}>
            <span className={`chip-t`}>{e.type}</span>
            <span className="small mono" style={{ wordBreak: 'break-all' }}>{JSON.stringify(e.data).slice(0, 160)}</span>
          </div>
        ))}
        {recent.length === 0 && <span className="muted small">Waiting for events…</span>}
      </div>
    </div>
  );
}
