import { devLoginEnabled } from '@/lib/api/config';

/**
 * Which sign-in methods /login should offer. `oidc` is true when
 * NEARESIS_OIDC=1 (set once the backend serves /v1/auth/*); the login page
 * then links to /api/auth/oidc/start.
 */
export async function GET() {
  return Response.json(
    { devLogin: devLoginEnabled(), oidc: process.env.NEARESIS_OIDC === '1' },
    { headers: { 'cache-control': 'no-store' } },
  );
}
