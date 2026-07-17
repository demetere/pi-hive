# Workflow Rewrite Execution Rules

These rules apply to all work under `notes/workflow-rewrite/` and to implementation work performed from its task files.

- The parent agent is the orchestrator. Delegate reconnaissance, planning, implementation, validation, and review to appropriate subagents; keep one writer in the active worktree at a time.
- Execute `W00` through `W28` strictly in numeric order. Do not start the next task until the current task is complete.
- Every implementation PR targets `develop/workflow-rewrite`, never `main`. After a task PR is merged, fetch the rebased integration branch and create the next descriptive implementation branch from `origin/develop/workflow-rewrite`; do not continue on the deleted/merged feature branch. After all ordered implementation PRs are integrated, use one final integration PR from `develop/workflow-rewrite` to `main`.
- Keep implementation PRs code-focused. Do not include local task numbers/phases, `notes/workflow-rewrite/**`, the architecture design, or subagent artifacts unless the user explicitly changes that scope.
- Workflow configuration fixtures live under `tests/fixtures/workflow-configs/`. Do not recreate or refer to the rejected `workflow-v1` directory name. Keep the narrow `.gitignore` exceptions that make nested fixture `.pi/` manifests trackable while runtime `.pi/`, local notes, and `.pi-subagents/` remain ignored.
- Before each task, read this file, `README.md`, the task file, its required design sections, root `AGENTS.md`, and every source/test file named by the task.
- Inspect the working tree before edits and preserve unrelated or untracked work.
- Use strict TDD for executable behavior: write the smallest failing test, run it and confirm the expected behavioral failure, implement the minimum change to pass, then refactor while green. Add a failing regression test before every bug fix.
- Record red and green evidence required by the task. Do not weaken or remove tests merely to get a pass.
- Before declaring a task complete, run all checks required by its task file and the workflow definition of done. All required tests must pass.
- After implementation and validation, run a fresh-context subagent review. Apply accepted findings through a single writer and repeat focused validation/review until there are no blocking or worthwhile in-scope findings.
- Only after the task is complete, required checks pass, and review is clean: commit with a Conventional Commit message, push the branch, and open a PR. Do not begin the next task until that PR exists.
- Do not add AI attribution to commits, PRs, documentation, or generated text.
