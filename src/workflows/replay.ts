import { verifyWorkflowEvent, type WorkflowEventEnvelope } from "./events";
import { readWorkflowJournal } from "./journal";
import { loadLatestCheckpoint } from "./checkpoints";

export interface ReplayResult<State> { readonly state: State; readonly lastSequence: number; readonly lastHash: string | null }
export type WorkflowReducer<State> = (state: State, event: WorkflowEventEnvelope) => State;

export function replayWorkflowJournal<State>(events: readonly WorkflowEventEnvelope[], initialState: State, reducer: WorkflowReducer<State>, start: { sequence: number; hash: string | null } = { sequence: 0, hash: null }): ReplayResult<State> {
  let state = structuredClone(initialState); let sequence = start.sequence; let hash = start.hash; const ids = new Set<string>();
  for (const event of events) {
    verifyWorkflowEvent(event);
    if (ids.has(event.eventId)) throw new Error("Workflow journal duplicate event ID"); ids.add(event.eventId);
    if (event.sequence !== sequence + 1) throw new Error("Workflow journal sequence gap or out-of-order event");
    if (event.previousHash !== hash) throw new Error("Workflow journal hash chain mismatch");
    state = reducer(state, event); sequence = event.sequence; hash = event.eventHash;
  }
  return Object.freeze({ state, lastSequence: sequence, lastHash: hash });
}

export function restoreWorkflowState<State>(projectRoot: string, sessionId: string, zero: State, reducer: WorkflowReducer<State>): ReplayResult<State> {
  const events = readWorkflowJournal(projectRoot, sessionId); const checkpoint = loadLatestCheckpoint<State>(projectRoot, sessionId);
  if (!checkpoint) return replayWorkflowJournal(events, zero, reducer);
  const anchor = events[checkpoint.lastSequence - 1];
  if (!anchor || anchor.eventHash !== checkpoint.lastHash) throw new Error("Checkpoint does not match authoritative journal");
  return replayWorkflowJournal(events.slice(checkpoint.lastSequence), checkpoint.state, reducer, { sequence: checkpoint.lastSequence, hash: checkpoint.lastHash });
}
