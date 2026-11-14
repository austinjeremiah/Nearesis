import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: resolve(here, "dist"), emptyOutDir: true },
  server: { host: "127.0.0.1", port: 4401, proxy: { "/api": "http://127.0.0.1:4400" } },
});
