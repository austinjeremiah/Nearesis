'use client';
import { TriangleAlert } from 'lucide-react';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="sp-shell">
      <div className="state" style={{ paddingTop: 96 }}>
        <div className="big"><TriangleAlert size={34} /></div>
        <h1 className="h2">Something broke</h1>
        <p className="muted">{error.message || 'Try again.'}</p>
        {error.digest && <p className="mono muted">{error.digest}</p>}
        <button className="btn" onClick={reset}>Reload</button>
      </div>
    </div>
  );
}
