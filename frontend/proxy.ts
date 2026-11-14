import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Cheap session gate for the app area: no cookie, no page. The cookie's
 * validity is the API's call (a 401 from any data fetch sends the person to
 * /login too); this only avoids rendering a shell that cannot load anything.
 * The marketing site, /login, /welcome, /accept-invite, /public/* and /api/*
 * are not matched.
 */
export function proxy(req: NextRequest) {
  if (req.cookies.has('nearesis_session')) return NextResponse.next();
  const login = new URL('/login', req.url);
  const next = req.nextUrl.pathname + req.nextUrl.search;
  if (next !== '/home') login.searchParams.set('next', next);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    '/home/:path*',
    '/thesis/:path*',
    '/workspaces/:path*',
    '/w/:path*',
    '/data/:path*',
    '/publications/:path*',
    '/notifications/:path*',
    '/system/:path*',
    '/settings/:path*',
  ],
};
