import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.join(__dirname);

const nextConfig: NextConfig = {
  devIndicators: false,
  // Dev server only: lets the smoke tests (and 127.0.0.1 in a browser) load dev chunks and HMR.
  allowedDevOrigins: ['127.0.0.1'],
  outputFileTracingRoot: root,
  turbopack: { root },
  async headers() {
    return [{ source: '/(.*)', headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] }];
  },
};
export default nextConfig;
