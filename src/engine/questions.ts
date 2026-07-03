import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../core/fs";
import { isSafeChangeId } from "./openspec";

// The clarifying-questions loop (WS-D) — pi-hive's own contribution on top of
// OpenSpec + Plannotator, neither of which round-trips agent→user questions.
//
// A planner (or planning lead) calls ask_user with a question. In the visible
// main session we block on ctx.ui.input and get the answer inline. A delegated
// (headless) planner has no UI, so it enqueues a `question` action into the MAIN
// session's dashboard-actions.jsonl; the main session surfaces it, the human
// answers, and an `answer` action is delivered so the planner's session resumes.
//
// Either way the Q&A is file-backed alongside the change so clarifications don't
// live only in chat.

// Append a Q (and optionally its answer) to questions.md under the change dir.
export function recordQuestion(cwd: string, change: string, question: string, answer?: string): void {
  if (!isSafeChangeId(change)) return;
  const dir = join(cwd, "openspec", "changes", change);
  try {
    ensureDir(dir);
    const stamp = new Date().toISOString();
    const block = answer
      ? `\n## Q (${stamp})\n${question}\n\n**A:** ${answer}\n`
      : `\n## Q (${stamp})\n${question}\n\n**A:** _pending_\n`;
    appendFileSync(join(dir, "questions.md"), block);
  } catch {
    /* best-effort file trail */
  }
}

// Enqueue a `question` action into a session's dashboard-actions.jsonl. Used when
// a headless planner must promote its question to the human-driven main session.
// The main session's poller renders it; the human's answer round-trips back.
export function enqueueQuestion(sessionDir: string, payload: { question: string; change?: string; askedBy?: string }): boolean {
  try {
    ensureDir(sessionDir);
    appendFileSync(
      join(sessionDir, "dashboard-actions.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), type: "question", ...payload })}\n`,
    );
    return true;
  } catch {
    return false;
  }
}
