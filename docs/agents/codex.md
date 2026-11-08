# Codex delegation and verification

1. **Brief.** Save a brief in the scratchpad or `/tmp/codex-runs/NAME.brief.md`. It contains:
   - the exact **owned** and **do-not-touch** paths
   - the contracts to read (`frontend/src/lib/types.ts`, `repo.ts`, `docs/api.md`, `docs/export-format.md`)
   - spec sections, with acceptance criteria and required validation
   - the screenshot location, `/tmp/codex-runs/NAME-shots/`
   - where shared-doc changes go: `/tmp/codex-runs/NAME-docs.md`
2. **Launch.** Run `scripts/codex-run NAME BRIEF --config 'model_reasoning_effort="high"'` with Bash `run_in_background`. Do not enable fast mode. Parallel tasks in a wave need disjoint owned paths.
3. **Watch.** In the same turn, monitor `scripts/codex-watch NAME 20 45` and re-arm it until it reports `DONE`. If it reports `STALLED`, `NETWORK reconnecting` or `PROCESS GONE`, inspect the log before resuming.
4. **Read the result.** Read `/tmp/codex-runs/NAME.last`, and the full log only to diagnose a failure.
5. **Verify independently.** A Codex report is not verification.
   - Review the diff against the brief.
   - Make sure no file outside the owned paths was touched.
   - Rerun the tests, types, format and build.
   - Compare test counts.
   - Open the screenshots and check that real data was rendered.
   - Check that no assertion was weakened.
6. **Fix rounds.** Run `scripts/codex-run NAME-fix BRIEF --resume "$(cat /tmp/codex-runs/NAME.session)"`. If resume reports an active writer, use `--fork`. Fix trivial blockers yourself.
7. **Commit.** The orchestrator commits each verified task with a Conventional Commit.
