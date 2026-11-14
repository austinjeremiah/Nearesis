import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@nearesis/canvas-schema", "@nearesis/contracts", "@nearesis/ui"],
  poweredByHeader: false,
  distDir: process.env.NEARESIS_WEB_DIST ?? ".next",
  // No source maps or eval in production bundles: CSP forbids 'unsafe-eval' (C10).
  productionBrowserSourceMaps: false,
};

export default config;
