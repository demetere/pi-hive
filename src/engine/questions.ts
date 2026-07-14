import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir } from "../core/fs";
import { withCrossProcessFileLock } from "../core/file-lock";
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
export async function recordQuestion(cwd: string, change: string, question: string, answer?: string): Promise<void> {
  if (!isSafeChangeId(change)) return;
  const dir = resolve(cwd, "openspec", "changes", change);
  const target = join(dir, "questions.md");
  try {
    await withFileMutationQueue(target, async () => {
      ensureDir(dir);
      const stamp = new Date().toISOString();
      const block = answer
        ? `\n## Q (${stamp})\n${question}\n\n**A:** ${answer}\n`
        : `\n## Q (${stamp})\n${question}\n\n**A:** _pending_\n`;
      withCrossProcessFileLock(target, () => appendFileSync(target, block));
    });
  } catch {
    /* best-effort file trail */
  }
}

// Enqueue a `question` action into a session's dashboard-actions.jsonl. Used when
// a headless planner must promote its question to the human-driven main session.
// The main session's poller renders it; the human's answer round-trips back.
export async function enqueueQuestion(sessionDir: string, payload: { question: string; change?: string; askedBy?: string }): Promise<boolean> {
  const target = resolve(sessionDir, "dashboard-actions.jsonl");
  try {
    return await withFileMutationQueue(target, async () => {
      ensureDir(sessionDir);
      withCrossProcessFileLock(target, () => {
        appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), type: "question", ...payload })}\n`);
      });
      return true;
    });
  } catch {
    return false;
  }
}
