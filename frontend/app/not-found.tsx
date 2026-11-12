import Link from 'next/link';
import './app.css';

/**
 * Spec 1.3 and 7.4: a workspace in another tenant returns the same response as
 * one that does not exist, so this copy must not hint which it was.
 */
export default function NotFound() {
  return (
    <div className="nx">
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '18vh 24px' }}>
        <div className="col gap4">
          <span className="label">404</span>
          <h1 className="h1">Page not found</h1>
          <p className="muted">
            That page does not exist, or you do not have access to it.
          </p>
          <div className="row gap2">
            <Link href="/" className="btn primary">
              Back to home
            </Link>
            <Link href="/workspaces" className="btn">
              My workspaces
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
