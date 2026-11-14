import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 3400, strictPort: true },
  preview: { host: "127.0.0.1", port: 3400, strictPort: true },
  resolve: { dedupe: ["react", "react-dom"] },
  build: { chunkSizeWarningLimit: 1200 },
});
