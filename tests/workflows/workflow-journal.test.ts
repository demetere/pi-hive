import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendWorkflowEvent, inspectJournal, readWorkflowJournal } from "../../src/workflows/journal.ts";
import { createWorkflowEvent } from "../../src/workflows/events.ts";
import { replayWorkflowJournal } from "../../src/workflows/replay.ts";

function fixture() { return { root: mkdtempSync(join(tmpdir(), "hive-journal-")), sessionId: "session-1", projectId: "project-1" }; }

test("journal append is hash-chained and deterministic replay works from zero", () => {
  const f = fixture();
  const first = appendWorkflowEvent(f.root, createWorkflowEvent({ projectId: f.projectId, sessionId: f.sessionId, type: "session.created", payload: { name: "one" }, producer: "runtime", timestamp: "2026-01-01T00:00:00.000Z", eventId: "e1" }));
  const second = appendWorkflowEvent(f.root, createWorkflowEvent({ projectId: f.projectId, sessionId: f.sessionId, type: "control.requested", payload: { action: "pause" }, producer: "dashboard", timestamp: "2026-01-01T00:00:01.000Z", eventId: "e2" }));
  assert.equal(first.sequence, 1); assert.equal(second.previousHash, first.eventHash);
  const events = readWorkflowJournal(f.root, f.sessionId); assert.equal(events.length, 2);
  const replayed = replayWorkflowJournal(events, { count: 0 }, (state) => ({ count: state.count + 1 }));
  assert.deepEqual(replayed.state, { count: 2 }); assert.equal(replayed.lastHash, second.eventHash);
});

test("partial, duplicate, gap, out-of-order, hash corrupt, and unknown versions fail closed", () => {
  const f = fixture(); appendWorkflowEvent(f.root, createWorkflowEvent({ projectId: f.projectId, sessionId: f.sessionId, type: "session.created", payload: {}, producer: "runtime", eventId: "e1" }));
  const dir = join(f.root, ".pi/hive/sessions", f.sessionId, "journal");
  writeFileSync(join(dir, ".partial.tmp"), "{");
  assert.equal(readWorkflowJournal(f.root, f.sessionId).length, 1, "incomplete unpublished temp is ignored");
  const base = readWorkflowJournal(f.root, f.sessionId)[0];
  for (const bad of [[base, base], [{ ...base, sequence: 2 }], [{ ...base, eventHash: "0".repeat(64) }], [{ ...base, formatVersion: 99 }]] as any[])
    assert.throws(() => replayWorkflowJournal(bad, {}, (s) => s), /sequence|hash|version|duplicate/i);
});

test("dashboard-style appends serialize safely across processes", async () => {
  const f = fixture();
  const run = (eventId: string) => new Promise<void>((resolve, reject) => {
    const script = `Promise.all([import('./src/workflows/journal.ts'),import('./src/workflows/events.ts')]).then(([j,e])=>j.appendWorkflowEvent(${JSON.stringify(f.root)},e.createWorkflowEvent({projectId:'project-1',sessionId:'session-1',type:'control.requested',payload:{},producer:'dashboard',eventId:${JSON.stringify(eventId)}})))`;
    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), stdio: "ignore" });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child ${eventId} exited ${code}`)));
  });
  await Promise.all([run("cross-1"), run("cross-2")]);
  assert.deepEqual(readWorkflowJournal(f.root, f.sessionId).map((event) => event.sequence), [1, 2]);
});

test("append faults leave old or new valid journal and summaries are bounded/redacted", () => {
  for (const stage of ["beforeWrite", "afterFileFsync", "beforeRename", "afterRename", "beforeDirFsync"] as const) {
    const f = fixture();
    try { appendWorkflowEvent(f.root, createWorkflowEvent({ projectId: f.projectId, sessionId: f.sessionId, type: "session.created", payload: { secret: "do-not-leak" }, producer: "runtime", eventId: "e1" }), { fault(stageNow) { if (stageNow === stage) throw new Error("crash"); } }); } catch { /* injected */ }
    const events = readWorkflowJournal(f.root, f.sessionId); assert.ok(events.length === 0 || events.length === 1, stage);
    if (events.length) assert.doesNotThrow(() => replayWorkflowJournal(events, {}, (s) => s));
    assert.equal(readdirSync(join(f.root, ".pi/hive/sessions", f.sessionId, "journal")).filter((name) => name.endsWith(".json")).length, events.length);
    const summary = inspectJournal(f.root, f.sessionId); assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 4096); assert.equal(JSON.stringify(summary).includes("do-not-leak"), false);
  }
});
