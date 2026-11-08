# Production infrastructure audit

Read-only audit of `kufang-prod` (`40.160.103.88`) on 2026-11-08, done before any change. No secrets are recorded here.

| Item | Finding |
|---|---|
| OS / Docker | Ubuntu 26.04 LTS, Docker Compose v5.6.1 |
| CPU / RAM | 2 vCPU, 3.7 GiB RAM (about 2.0 GiB available), 2 GiB swap |
| Disk | 38 GB root, 25 GB free |
| Firewall | ufw allows only 22, 80 and 443. Only Traefik publishes ports. |
| Running stacks | `kufang-production` (ERPNext: MariaDB 11.8, Redis ×2, Frappe backend/frontend/websocket/queue-short/queue-long/scheduler) and `kufang-edge` (Traefik v3.7) |
| Memory in use | Frappe backend about 590 MiB, MariaDB about 300 MiB, the others under 100 MiB each |
| Networks | `kufang-edge` (Traefik provider network) and `kufang-production_default` |
| Volumes | `kufang-edge_cert-data` and `kufang-production_{db-data,logs,redis-queue-data,sites}` |
| Routes | `Host(kufang.org)` → ERPNext frontend; `www.kufang.org` → redirect to the apex. The apex sets HSTS includeSubDomains. |
| TLS | Let's Encrypt HTTP-01 through Traefik resolver `le`. CAA `issue letsencrypt.org`. |
| ERPNext backups | `kufang-backup@production.timer` runs nightly at 08:15 UTC to B2. Kufang Capture is not part of it. |
| DNS | Spaceship. `capture.kufang.org` did not exist before. MX/SPF/DKIM/DMARC belong to Resend and ERPNext and are not touched. |

## Kufang Capture footprint (after install)

- A new system user `kufang-capture` (in the docker group), with home `/srv/kufang-capture` (mode 0750).
- Compose project `kufang-capture`, service `capture`, volume `kufang-capture-data`. The service joins the external network `kufang-edge` and publishes no ports.
- Limits: `mem_limit 384m`, `cpus 1.0`, `pids_limit 256`. The filesystem is read-only, all capabilities are dropped, and `no-new-privileges` is set.
- Traefik router `kufang-capture` (`Host(capture.kufang.org)`) and middleware `kufang-capture-security`.
- DNS: one `A capture → 40.160.103.88` record, added on 2026-11-08 with the existing Spaceship helper. Its plan showed one addition and no deletions.
- CI deploy key: an `authorized_keys` entry for `kufang-capture`, restricted to `command="/srv/kufang-capture/bin/deploy",restrict`.
- Every deploy is bracketed by `scripts/prod-guard`. It checks that the IDs, start times and restart counts of all `kufang-production-*` and `kufang-edge-*` containers are unchanged, and that `https://kufang.org/api/method/ping` still answers.
