# Codex delegation and verification

The default route is the **T3 Code harness** (`delegate_task`). Use `scripts/codex-run` only when the T3 tools are not available, for example in a plain terminal session.

1. **Brief.** Save a brief at `/tmp/codex-runs/NAME.brief.md`. It contains:
   - the exact **owned** and **do-not-touch** paths
   - the contracts to read (`frontend/src/lib/types.ts`, `repo.ts`, `docs/api.md`, `docs/export-format.md`)
   - spec sections, with acceptance criteria and required validation
   - the screenshot location, `/tmp/codex-runs/NAME-shots/`
   - where shared-doc changes go: `/tmp/codex-runs/NAME-docs.md`
   - the instruction to leave changes uncommitted and to run no state-changing git commands
2. **Launch (T3, default).** Call `orchestrator_capabilities` once per thread. Then call `delegate_task` with:
   - `target: {providerInstanceId: "codex", model: "gpt-6-luna", options: {reasoningEffort: "high", serviceTier: "priority"}}`. Use `medium` for small tasks. Fast mode (`priority`) is the owner's preference (2026-11-26). Workspace accounts `codex_ws1`..`codex_ws4` may also use `gpt-6.2-sol`.
   - `role: "implementation"` and a short `title`
   - `task`: "Implement the task in /tmp/codex-runs/NAME.brief.md …". The child sees no parent history, so the brief must stand on its own. Never put secrets in it.
   - `isolation`: `shared` (the main checkout) for one task. Use `worktree` for parallel waves whose owned paths might collide, or when each child needs its own branch.

   Do not poll. Completion wakes the orchestrator thread, so keep working on other things (docs, the next brief) and end the turn when nothing is left. To stop a run you no longer need, use `task_cancel`.

   **Fallback (no T3).** Run `scripts/codex-run NAME BRIEF --config 'model_reasoning_effort="high"'` with Bash `run_in_background`. In the same turn, arm a Monitor on `scripts/codex-watch NAME 20 45` and re-arm it until it reports `DONE`. The report is in `/tmp/codex-runs/NAME.last`.

   **Codex usage limit.** Use Claude Haiku subagents for scoped tasks, and switch back to Codex once it is available again.
3. **Read the result.** Read the child's final report (the task completion, or `NAME.last` on the fallback route). Read the full transcript or log only to diagnose a failure.
4. **Verify independently.** A Codex report is not verification.
   - Review the diff against the brief.
   - Make sure no file outside the owned paths was touched.
   - Rerun the tests, types, format and build.
   - Compare test counts.
   - Open the screenshots and check that real data was rendered.
   - Check that no assertion was weakened.
5. **Fix rounds.** Start a new `delegate_task` whose brief holds the findings and the original brief path. Fix trivial blockers yourself. On the fallback route, use `scripts/codex-run NAME-fix BRIEF --resume "$(cat /tmp/codex-runs/NAME.session)"`, or `--fork` if resume reports an active writer.
6. **Commit.** The orchestrator commits each verified task with a Conventional Commit.
