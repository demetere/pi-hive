import { HOST, IDLE_TIMEOUT_MS, PORT, REGISTRY_PATH } from "./config";
import { createDashboardHttpHandler } from "./http-handler";
import { sourcePaths, startTelemetryRuntime } from "./runtime";
import { broadcastPing, subscribers } from "./sse";

startTelemetryRuntime();

// Keep idle EventSource connections alive through browsers and proxies.
const heartbeatTimer = setInterval(broadcastPing, 15_000);
let lastActivityAt = Date.now();
let shuttingDown = false;
let idleTimer: ReturnType<typeof setInterval>;

function scheduleServerStop(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => {
    clearInterval(heartbeatTimer);
    clearInterval(idleTimer);
    server.stop(true);
    process.exit(0);
  }, 50);
}

const handleRequest = createDashboardHttpHandler({
  onActivity() { lastActivityAt = Date.now(); },
  scheduleServerStop,
});

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // SSE connections are intentionally long-lived and may be idle between
  // heartbeat frames, so disable Bun's per-connection idle timeout.
  idleTimeout: 0,
  fetch: handleRequest,
});

// The daemon is shared across Pi sessions, so a single session shutdown cannot
// terminate it. Stop only after bounded inactivity with no browser stream.
idleTimer = setInterval(() => {
  if (subscribers.size === 0 && Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS) scheduleServerStop();
}, Math.min(60_000, Math.max(1_000, Math.floor(IDLE_TIMEOUT_MS / 4))));

console.log(`pi-hive telemetry dashboard: http://${HOST}:${PORT}`);
console.log(`registry: ${REGISTRY_PATH}`);
console.log(`sources: ${sourcePaths().length}`);
