import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.join(__dirname);

const nextConfig: NextConfig = {
  devIndicators: false,
  outputFileTracingRoot: root,
  turbopack: { root },
  async headers() {
    return [{ source: '/(.*)', headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] }];
  },
};
export default nextConfig;
