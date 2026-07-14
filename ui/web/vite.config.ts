import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard is served by src/observability/static.ts from this dist/ folder
// at the server root. `base: "/"` makes asset URLs absolute so they resolve to
// /assets/* regardless of the client-route depth (e.g. /project/foo/cost must
// still load /assets/index.js, not /project/foo/assets/index.js). During UI
// development, the vite dev server proxies API endpoints to the Bun server.
const API_PORT = (globalThis as any).process?.env?.HIVE_TELEMETRY_PORT || "43191";
const target = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 43192,
    // During UI dev, proxy every dashboard-server route to the Bun server so the
    // Vite HMR frontend talks to the real backend. /pl-review + /api carry the
    // self-hosted Plannotator review surface (the review iframe + its handlers).
    proxy: {
      "/events": target,
      "/states": target,
      "/sessions": target,
      "/stream": target,
      "/health": target,
      "/plans": target,
      "/agent-log": target,
      "/projects": target,
      "/bootstrap.json": target,
      "/topologies": target,
      "/models": target,
      "/delegations": target,
      "/tool-calls": target,
      "/storage": target,
      "/conversation": target,
      "/thinking": target,
      "/project-overrides": target,
      "/review-sessions": target,
      "/pl-review": target,
      "/api": target,
    },
  },
});
