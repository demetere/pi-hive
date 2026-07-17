# W21 — Implement Durable Human Questions and Answer Races

Status: **Not started**  
Depends on: W20  
Blocks: W22

## Mandatory TDD sequence

For every executable behavior in this task, write or update the smallest automated test **before** production/helper implementation. Run the narrowest test command and confirm it fails for the expected missing-behavior reason—not because of unrelated setup, syntax, or type errors. Then implement only enough to pass, rerun to green, and refactor while green. Add a failing regression test before every bug fix. Record the red and green commands/results in Handoff; never weaken or delete a test merely to make implementation pass.

## Outcome

Generalize human input into persisted structured questions that survive restart/offline periods, release worker slots, accept exactly one valid answer through authenticated live/TUI/dashboard/command channels, and resume the same node/task transcript.

## Design authority

- Design Sections 9.3 (`human-input`), 15, 18.1, 19.1–19.2, and Risk 25.4
- Ordinary root chat is separate from persisted structured question authority

## Current touchpoints to inspect

- `src/engine/questions.ts`, question handling in `src/engine/dispatch.ts`/worker extension
- review/dashboard async control routes and DB state
- `tests/questions.test.ts`, worker/session/daemon tests
- W09 control events, W11 states, W12 worker suspension, W14 tool descriptors

## Question contract

Persist:

- question ID, project/session/run/node/task IDs;
- bounded prompt;
- answer kind `single|multi|text|confirm`;
- typed choices/validation/required flag;
- creation provenance/timestamp/state;
- first accepted answer and channel/identity/timestamp;
- terminal closure reason where unanswered.

No arbitrary HTML/executable UI. Unknown fields and oversized choices/prompts fail.

## Required behavior

- `human_question` exists only with effective `human-input: true`.
- Persist pending state before presenting live UI.
- Live first valid answer CAS wins.
- Without UI, suspend/end current worker turn, release scheduler slot, set run waiting state when appropriate, and expose dashboard queue.
- Do not leave an in-memory tool promise blocked across shutdown.
- Offline authenticated dashboard may append answer while Pi is absent; model resumes only when owner returns.
- Later Pi session may answer via `/hive:answer <id> [value]`.
- Ordinary chat is run steering and never accidentally satisfies a structured question.
- Terminal cancelled/failed/blocked atomically closes pending questions; late answers reject.
- No background model daemon.

## Target modules

- `src/workflows/questions.ts`
- `src/workflows/question-validation.ts`
- generic control service contract for W25/W26
- integrate scheduler/run reducers/prompts/tool registration

## Implementation plan

1. Define typed schema/limits and question/answer/close events.
2. Implement creation authorization and journal-first pending transition.
3. Implement validation/CAS shared by live UI, dashboard, and command channels.
4. Integrate worker suspension/resume using durable task transcript markers; no slot while waiting.
5. Derive run `waiting_for_human` only when no other runnable progress exists; resume deterministically after answer.
6. Inject accepted answer into same node/task transcript with provenance, not a new task.
7. Implement terminal atomic closure and late/replay denial.
8. Expose bounded status/control DTO for W25/W26.
9. Test offline append without model execution.

## Required tests

- Capability absent/present and root ordinary-chat distinction.
- Every answer kind, validation, bounds, malformed/unknown fields.
- Persist-before-present and restart before/after presentation.
- Live/dashboard/command concurrent answer races: first valid wins.
- Worker slot release, waiting state derivation, same transcript/task resume.
- Ordinary chat cannot answer question accidentally.
- Terminal close versus late answer race.
- Offline dashboard answer persists but no model runs until owner resumes.
- No leaked promises/timers/listeners after shutdown.

## Out of scope

- Final dashboard route/UI and TUI component (W25/W26).
- Approval checkpoints (already W18).
- Automatic question answering/defaults.

## Verification

- Question/restart/race/scheduler/session tests
- `just typecheck-core`
- `just test`
- `just verify`

## Completion checklist

- [ ] Questions are durable typed state, not blocked promises.
- [ ] Only authorized first valid answer is accepted.
- [ ] Workers release slots and resume same transcript/task.
- [ ] Ordinary chat remains steering, not implicit answer.
- [ ] Offline controls never execute models.

## Handoff

Record question/answer schemas, limits, CAS API, channel provenance, waiting-state derivation, scheduler resume event, and DTO W25/W26 implement.
