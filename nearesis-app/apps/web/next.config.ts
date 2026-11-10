import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@nearesis/canvas-schema", "@nearesis/contracts"],
  poweredByHeader: false,
  // No source maps or eval in production bundles: CSP forbids 'unsafe-eval' (C10).
  productionBrowserSourceMaps: false,
};

export default config;
