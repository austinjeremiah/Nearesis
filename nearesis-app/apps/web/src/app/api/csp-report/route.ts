/** Collects CSP violation reports (C10b). In-memory, bounded; GET returns them for test inspection (non-production only). */
const reports: unknown[] = [];

export async function POST(req: Request) {
  const text = (await req.text()).slice(0, 20_000);
  try {
    reports.push(JSON.parse(text));
  } catch {
    reports.push({ unparsed: text });
  }
  if (reports.length > 500) reports.splice(0, reports.length - 500);
  return new Response(null, { status: 204 });
}

export async function GET() {
  if (process.env.NODE_ENV === "production" && !process.env.NEARESIS_TEST_HOOKS)
    return new Response("not found", { status: 404 });
  return Response.json({ count: reports.length, reports });
}

export async function DELETE() {
  reports.length = 0;
  return new Response(null, { status: 204 });
}
