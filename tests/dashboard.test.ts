import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureDashboard, dashboardUrl } from "../src/engine/dashboard.ts";
import type { HiveState } from "../src/core/types.ts";

// The dashboard daemon's adopt/spawn/gate DECISION, tested deterministically via
// injected seams — no real Bun process, socket, or browser. (The end-to-end
// spawn is exercised manually; here we lock the control flow.)

function state(): HiveState {
  return { session: { sessionId: "s1", sessionDir: "/tmp/s", observabilityLog: "/tmp/s/e", conversationLog: "/tmp/s/c" } } as any;
}
const ctx = { cwd: "/repo/proj", mode: "rpc", hasUI: false } as any;
const ROOT = "/repo";

function deps(over: Partial<Parameters<typeof ensureDashboard>[4]> = {}) {
  const calls = { spawned: 0, opened: 0 };
  const base = {
    isRunning: async () => false,
    bunAvailable: () => true,
    spawn: (s: HiveState) => { calls.spawned++; (s as any).obsServer = { url: dashboardUrl(), port: 0, host: "127.0.0.1", adopted: false, proc: { pid: 1 } }; return { ok: true }; },
    open: () => { calls.opened++; },
    ...over,
  };
  return { deps: base, calls };
}

test("adopts an already-running daemon without spawning", async () => {
  const s = state();
  const { deps: d, calls } = deps({ isRunning: async () => true });
  const r = await ensureDashboard(s, ctx, ROOT, {}, d);
  assert.equal(r.adopted, true);
  assert.equal(r.spawned, false);
  assert.equal(calls.spawned, 0);
  assert.equal(s.obsServer?.adopted, true);
  assert.equal(s.obsServer?.proc, undefined); // adopted → not ours to kill
});

test("spawns when no daemon is running", async () => {
  const s = state();
  const { deps: d, calls } = deps({ isRunning: async () => false });
  const r = await ensureDashboard(s, ctx, ROOT, {}, d);
  assert.equal(r.spawned, true);
  assert.equal(r.adopted, false);
  assert.equal(calls.spawned, 1);
  assert.ok(s.obsServer?.proc); // spawned → we own the proc
});

test("is Bun-gated: no Bun ⇒ no spawn, bunMissing flagged", async () => {
  const s = state();
  const { deps: d, calls } = deps({ isRunning: async () => false, bunAvailable: () => false });
  const r = await ensureDashboard(s, ctx, ROOT, {}, d);
  assert.equal(r.running, false);
  assert.equal(r.bunMissing, true);
  assert.equal(calls.spawned, 0);
});

test("does not open a browser on auto-start (open omitted)", async () => {
  const s = state();
  const { deps: d, calls } = deps({ isRunning: async () => false });
  await ensureDashboard(s, ctx, ROOT, { open: false }, d);
  assert.equal(calls.opened, 0);
});

test("opens a browser only when open:true (the explicit command)", async () => {
  const s = state();
  const { deps: d, calls } = deps({ isRunning: async () => false });
  await ensureDashboard(s, ctx, ROOT, { open: true }, d);
  assert.equal(calls.opened, 1);
});

test("adopt path opens the browser when open:true", async () => {
  const s = state();
  const { deps: d, calls } = deps({ isRunning: async () => true });
  await ensureDashboard(s, ctx, ROOT, { open: true }, d);
  assert.equal(calls.opened, 1);
  assert.equal(calls.spawned, 0);
});
