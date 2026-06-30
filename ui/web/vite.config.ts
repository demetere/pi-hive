import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The dashboard is served by src/observability/server.ts from this dist/ folder.
// `base: "./"` makes all asset URLs relative so it works regardless of the
// path the server mounts it at. During UI development, `vite` dev server
// proxies the API endpoints to the running Bun telemetry server.
const API_PORT = (globalThis as any).process?.env?.HIVE_TELEMETRY_PORT || "43191";

export default defineConfig({
  base: "./",
  plugins: [solid()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 43192,
    proxy: {
      "/events": `http://127.0.0.1:${API_PORT}`,
      "/states": `http://127.0.0.1:${API_PORT}`,
      "/sessions": `http://127.0.0.1:${API_PORT}`,
      "/stream": `http://127.0.0.1:${API_PORT}`,
      "/health": `http://127.0.0.1:${API_PORT}`,
    },
  },
});
