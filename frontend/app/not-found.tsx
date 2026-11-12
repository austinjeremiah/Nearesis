import Link from 'next/link';
import './app.css';

export default function NotFound() {
  return (
    <div className="sp">
      <div className="sp-shell">
        <div className="state" style={{ paddingTop: 96 }}>
          <div className="big" style={{ fontWeight: 700, fontSize: 28 }}>404</div>
          <h1 className="h2">Page not found</h1>
          <p className="muted">That page doesn&apos;t exist.</p>
          <Link href="/" className="btn">Home</Link>
        </div>
      </div>
    </div>
  );
}
