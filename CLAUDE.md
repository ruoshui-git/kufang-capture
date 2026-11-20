# Claude Code guide

@AGENTS.md

## Codex delegation

Use Codex for scoped implementation tasks. See [docs/agents/codex.md](docs/agents/codex.md) for the full workflow and the verification checklist.

**Default: the T3 Code harness.** Write the brief to `/tmp/codex-runs/NAME.brief.md`, then call `delegate_task` with `target: {providerInstanceId: "codex", model: "gpt-6-luna", options: {reasoningEffort: "high"|"medium", serviceTier: "default"}}` and `role: "implementation"`, with a `task` that points at the brief. Don't poll; the child's completion wakes you. Use `isolation: "worktree"` only for parallel waves that need separate checkouts.

**Fallback (T3 tools unavailable):** `scripts/codex-run NAME BRIEF [--resume|--fork SESSION] --config 'model_reasoning_effort="medium|high"'` with Bash `run_in_background`, plus a Monitor on `scripts/codex-watch NAME 20 45`.

Use the regular service tier. Fast mode (`serviceTier: "priority"` / `service_tier="fast"`) is only for when the owner asks. If Codex hits its usage limit, use Claude Haiku subagents for scoped tasks and go back to Codex once it is available. Parallel waves are fine when their owned paths are disjoint. Codex leaves its changes uncommitted; review, verify and commit them as the orchestrator.

## Production access

`ssh kufang-prod` (admin `ubuntu`, key in the operator's ssh-agent at `~/.ssh/agent.sock`). If it fails with `Permission denied (publickey)`, the agent was lost (WSL restart): ask the owner to re-run `ssh-agent -a ~/.ssh/agent.sock` + `ssh-add ~/.ssh/id_ed25519_ovh`.

DNS: `SPACESHIP_CREDENTIALS=/home/ruoshui/code/frappe_docker_wsl/development/frappe-bench/apps/temple_inventory/credentials/spaceship-api-key python3 -I /home/ruoshui/code/frappe_docker_wsl/development/frappe-bench/apps/temple_inventory/scripts/spaceship-dns {list|plan|apply} …` — never print or copy the credential file.
