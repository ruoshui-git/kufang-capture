# Claude Code guide

@AGENTS.md

## Delegating work

You orchestrate; Codex agents write most of the code. Your own job is planning, briefs, review, and every write to shared environments (git, deploys, production, DNS). See [docs/agents/codex.md](docs/agents/codex.md) for the verification checklist.

1. **Plan first.** For any non-trivial change, investigate, then present a plan (what changes, user-visible effects, open questions as concrete choices) and wait for explicit owner approval before implementing.
2. **Delegate through T3 Code.** Call `orchestrator_capabilities` once per thread, then `delegate_task` with `role: "implementation"`, one task per independent piece. Parallel tasks are fine when their files don't overlap; give them `isolation: "worktree"`. When no other orchestrator is working on the repo and the task is a single piece, it may run in the main checkout instead.
   - Models: personal account `codex` → `gpt-6-luna` only; workspace accounts `codex_ws1`..`codex_ws4` → `gpt-6.2-sol` or `gpt-6-luna`.
   - Prefer fast mode for Codex (`serviceTier: "priority"`). Claude subagents never run in fast mode.
   - Don't poll a running delegate; wait for its completion notification.
   - If Codex hits its usage limit, use Claude Haiku subagents for scoped tasks and go back to Codex once it is available.
3. **Write a brief file** in the scratchpad (or `/tmp/codex-runs/NAME.brief.md`) for each task. The child sees no parent history, so the brief stands on its own:
   - the goal and the user-visible behaviour wanted, including the owner's exact decisions;
   - **owned files** (may edit) and **forbidden** files/dirs; no commits, no subagents, no calls to staging/production/remote hosts, no credentials or backups;
   - test data: work on copies, never on live data or a running service the owner uses (use other ports);
   - acceptance: the tests to add, expected numbers, lint/format/test commands, browser checks at named sizes;
   - report format: changes per file, test counts, open doubts, worktree path; leave the work uncommitted.
4. **A delegate's report is not verification.** Read every diff, rerun lint and the full test suite, compare test counts, and check the result in a browser yourself. Then start a fresh `delegate_task` as an independent reviewer (brief + diff + what to look for). Fix small findings yourself; re-delegate only larger ones. The orchestrator commits each verified task with a Conventional Commit.

**Fallback (T3 tools unavailable):** `scripts/codex-run NAME BRIEF [--resume|--fork SESSION] --config 'model_reasoning_effort="medium|high"'` with Bash `run_in_background`, plus a Monitor on `scripts/codex-watch NAME 20 45`.

## Production access

`ssh kufang-prod` (admin `ubuntu`, key in the operator's ssh-agent at `~/.ssh/agent.sock`). If it fails with `Permission denied (publickey)`, the agent was lost (WSL restart): ask the owner to re-run `ssh-agent -a ~/.ssh/agent.sock` + `ssh-add ~/.ssh/id_ed25519_ovh`.

DNS: `SPACESHIP_CREDENTIALS=/home/ruoshui/code/frappe_docker_wsl/development/frappe-bench/apps/temple_inventory/credentials/spaceship-api-key python3 -I /home/ruoshui/code/frappe_docker_wsl/development/frappe-bench/apps/temple_inventory/scripts/spaceship-dns {list|plan|apply} …` — never print or copy the credential file.
