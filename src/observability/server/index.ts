import { HOST, IDLE_TIMEOUT_MS, PORT, PROJECT_CWD, WORKFLOW_DB_PATH } from "./config";
import { createDashboardHttpHandler } from "./http-handler";
import { createConfiguredWorkflowProjectionSynchronizer } from "./workflow-runtime";
import { broadcastPing, broadcastWorkflowEvent, closeAllSubscribers, hasLiveSubscribers } from "./sse";
import { encodeWorkflowHistoryCursor } from "../projection";

const projection = createConfiguredWorkflowProjectionSynchronizer({ databasePath: WORKFLOW_DB_PATH, onEvent: (event) => broadcastWorkflowEvent(event, encodeWorkflowHistoryCursor(event)) });
const synchronize = (): void => { try { projection.sync([PROJECT_CWD]); } catch { /* diagnostics are exposed by projection status/rebuild */ } };
synchronize();
const projectionTimer = setInterval(synchronize, 1_000);
const heartbeatTimer = setInterval(broadcastPing, 15_000);
let lastActivityAt = Date.now(); let shuttingDown = false;
const handleRequest = createDashboardHttpHandler({ onActivity() { lastActivityAt = Date.now(); }, scheduleServerStop });
const server = Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 0, fetch: handleRequest });
const idleTimer = setInterval(() => { if (!hasLiveSubscribers() && Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS) scheduleServerStop(); }, Math.min(60_000, Math.max(1_000, Math.floor(IDLE_TIMEOUT_MS / 4))));
function scheduleServerStop(): void {
  if (shuttingDown) return; shuttingDown = true;
  setTimeout(() => { clearInterval(projectionTimer); clearInterval(heartbeatTimer); clearInterval(idleTimer); handleRequest.dispose(); projection.close(); closeAllSubscribers(); void server.stop(true); process.exit(0); }, 50);
}
process.once("SIGINT", scheduleServerStop); process.once("SIGTERM", scheduleServerStop);
console.log(`pi-hive workflow dashboard: http://${HOST}:${PORT}`);
