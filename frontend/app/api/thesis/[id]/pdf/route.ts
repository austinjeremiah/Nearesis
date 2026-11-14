import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/api/config';
import { sameOrigin, isSecureRequest } from '@/lib/auth/session';
import { unauthenticated } from '@/lib/auth/bff';
import { thesisPdfFilename } from '@/lib/thesis/document';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const ID = /^[A-Za-z0-9._-]{1,120}$/;
const READY_TIMEOUT_MS = 60_000;
const NO_STORE = { 'cache-control': 'no-store' } as const;

const fail = (status: number, errorCode: string, reasonCode: string, message: string) =>
  Response.json({ errorCode, reasonCode, message, retryable: status >= 500 }, { status, headers: NO_STORE });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * `GET /api/thesis/<thesis id>/pdf`: renders `/thesis/<id>/document` (the thesis document in the workspace report's design) with headless Chromium and returns it as an A4 PDF download.
 *
 * Same-origin and signed in: the reader's own session cookie is placed on the browser context, so the page (and the API call
 * behind it) can only show what the reader may read; a thesis the reader cannot open is the document page's 404 and
 * comes back here as 404. The page is loaded from this same server (never from a URL the caller supplies). Waits up to 60 s
 * for `data-thesis-ready="true"`; a longer wait is a 504. The browser is always closed.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID.test(id) || id === '.' || id === '..') return fail(404, 'NOT_FOUND', 'THESIS_NOT_FOUND', 'Thesis not found.');
  // A browser navigation to this URL carries no Origin header; any cross-origin fetch does, and must be this origin.
  if (!sameOrigin(req)) return fail(403, 'FORBIDDEN', 'ORIGIN_NOT_ALLOWED', 'Origin not allowed.');
  if (req.headers.get('sec-fetch-site') === 'cross-site') return fail(403, 'FORBIDDEN', 'ORIGIN_NOT_ALLOWED', 'Origin not allowed.');
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return unauthenticated();

  // The page is fetched from this very server, on the host the request arrived at.
  const url = new URL(req.url);
  const host = req.headers.get('host') ?? url.host;
  const proto = isSecureRequest(req) ? 'https' : 'http';
  const origin = `${proto}://${host}`;

  let browser: import('playwright').Browser | null = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1100, height: 1400 }, deviceScaleFactor: 2, colorScheme: 'light' });
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: origin, httpOnly: true, sameSite: 'Strict', secure: proto === 'https' }]);
    const page = await context.newPage();
    const resp = await page.goto(`${origin}/thesis/${encodeURIComponent(id)}/document`, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS });
    const status = resp?.status() ?? 0;
    if (status === 404) return fail(404, 'NOT_FOUND', 'THESIS_NOT_FOUND', 'Thesis not found.');
    if (status === 401 || new URL(page.url()).pathname.startsWith('/login')) return unauthenticated();
    try {
      await page.waitForSelector('[data-thesis-ready="true"], [data-thesis-error]', { timeout: READY_TIMEOUT_MS });
    } catch {
      return fail(504, 'GATEWAY_TIMEOUT', 'THESIS_NOT_READY', 'The thesis did not finish rendering within 60 seconds.');
    }
    if (await page.locator('[data-thesis-error]').count()) {
      const code = await page.locator('[data-thesis-error]').first().getAttribute('data-thesis-error');
      return fail(502, 'UPSTREAM_DEGRADED', code ?? 'THESIS_UNAVAILABLE', 'The thesis data could not be read.');
    }
    const title = (await page.locator('[data-thesis-title]').first().getAttribute('data-thesis-title')) ?? 'Thesis';
    const generated = (await page.locator('[data-thesis-generated]').first().getAttribute('data-thesis-generated')) ?? '';
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: '20mm', bottom: '18mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="width:100%;padding:0 14mm;font-family:Helvetica,Arial,sans-serif;font-size:7.5px;color:#77766a;display:flex;justify-content:space-between;letter-spacing:.04em"><span style="text-transform:uppercase">Nearesis thesis</span><span>${esc(title)}</span></div>`,
      footerTemplate: `<div style="width:100%;padding:0 14mm;font-family:Helvetica,Arial,sans-serif;font-size:7.5px;color:#77766a;display:flex;justify-content:space-between"><span>Generated ${esc(generated.slice(0, 16).replace('T', ' '))} UTC. Testnet only.</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${thesisPdfFilename(id)}"`,
        'content-length': String(pdf.length),
        ...NO_STORE,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    // Never echo the cookie; a missing browser binary is the usual operational cause.
    return fail(500, 'INTERNAL', 'PDF_RENDER_FAILED', `The PDF could not be rendered: ${msg.split('\n')[0]!.replace(token, '[session]').slice(0, 200)}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
