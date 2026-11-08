# Claude Code guide

@AGENTS.md

## Codex delegation

Use Codex for scoped implementation tasks through `scripts/codex-run`; see [docs/agents/codex.md](docs/agents/codex.md) for the full workflow and verification checklist.

```sh
scripts/codex-run NAME BRIEF [--resume|--fork SESSION] --config 'model_reasoning_effort="medium|high"'
```

Fast mode (`--config 'service_tier="fast"'`) is allowed while Codex has quota; if Codex hits its usage limit, fall back to Claude Haiku subagents for scoped tasks and return to Codex once available. Launch with Bash `run_in_background`; in the same turn arm a Monitor on `scripts/codex-watch NAME 20 45`. Parallel waves are fine when owned paths are disjoint. Codex leaves changes uncommitted; review, verify and commit as the orchestrator.

## Production access

`ssh kufang-prod` (admin `ubuntu`, key in the operator's ssh-agent at `~/.ssh/agent.sock`). If it fails with `Permission denied (publickey)`, the agent was lost (WSL restart): ask the owner to re-run `ssh-agent -a ~/.ssh/agent.sock` + `ssh-add ~/.ssh/id_ed25519_ovh`.

DNS: `SPACESHIP_CREDENTIALS=/home/ruoshui/code/frappe_docker_wsl/development/frappe-bench/apps/temple_inventory/credentials/spaceship-api-key python3 -I /home/ruoshui/code/frappe_docker_wsl/development/frappe-bench/apps/temple_inventory/scripts/spaceship-dns {list|plan|apply} …` — never print or copy the credential file.
