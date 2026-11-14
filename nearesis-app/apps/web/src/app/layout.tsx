import type { Metadata } from "next";
import { headers } from "next/headers";
import "@nearesis/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = { title: "Nearesis", description: "Verifiable research canvas" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request headers makes every page dynamic, so Next applies the per-request CSP nonce.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
