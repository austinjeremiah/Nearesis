import { defineConfig } from "vite";
// Local only: bound to 127.0.0.1, fixed port, no network exposure.
// The Meteor SDK pulls in `safe-buffer`, which needs Node's `buffer`; alias it
// to the browser polyfill (feross/buffer) instead of Vite's empty stub.
export default defineConfig({
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  define: { global: "globalThis", "process.env.NODE_DEBUG": "undefined" },
  resolve: { alias: { buffer: "buffer/" } },
  optimizeDeps: { include: ["buffer"] },
});
