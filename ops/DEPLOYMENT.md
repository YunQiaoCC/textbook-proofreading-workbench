# Production deployment

This document describes a generic single-process deployment. Real domains,
hostnames, addresses, usernames, paths, secrets, storage, and installed service
configuration are intentionally kept outside the repository.

```text
HTTPS
  |
Nginx
  |-- Vue static bundle and /login
  `-- /api reverse proxy
          |
    one Node.js process
    opaque HttpOnly sessions
          |
    private file-backed storage
```

Nginx must never serve runtime storage. Every product API route, including PDF
GET and HEAD, requires a valid Node-side session. Only login, session status,
and logout are public API routes.

## Shared access model

The workbench uses one shared account for a seven-person editorial team. Each
browser receives an independent random session. The login name is only an
access gate: chapter and issue reviewer identity remains the selected chapter
assignee.

Sessions are process-memory state and expire after seven days by default. A
restart invalidates sessions without changing documents, chapters,
annotations, issues, or AI review state. The file-backed locking model requires
exactly one Node process; do not use clustering or multiple API workers.

`POST /api/auth/login` uses a bounded, process-memory rate limiter keyed by the
client IP supplied through `X-Real-IP` by a trusted loopback proxy. The default
is 10 failed attempts in 10 minutes with at most 10,000 active identities. A
successful login clears that identity's failure bucket. The limiter does not
apply to authenticated APIs.

## Host-specific configuration

Use a dedicated service account and host-owned directories. The checked-in
templates use these examples:

- application: `/opt/legal-textbook-proofreading-workbench`
- persistence: `/var/lib/legal-textbook-proofreading-workbench`
- environment files: `/etc/legal-textbook-proofreading-workbench/`
- backups: `/var/backups/legal-textbook-proofreading-workbench`
- public host: `proofreading.example.com`

Adapt copies during installation. Do not commit the adapted files. Updating the
repository must not overwrite an already-installed Nginx site or systemd unit.

## Environment files

Authentication is required in production. Store the real values in a
root-managed file outside Git:

```text
WORKBENCH_ACCESS_USERNAME=<shared-login-name>
WORKBENCH_ACCESS_PASSWORD=<long-random-secret>
```

The service unit sets `WORKBENCH_AUTH_REQUIRED=1` and loads this file without
the optional `-` prefix, so a missing credential file fails closed.

Optional integrations use separate external files:

```text
DEEPSEEK_API_KEY=<secret>
YUANDIAN_API_KEY=<secret>
```

Missing optional provider configuration must leave the core workbench usable.
Never place credentials, session IDs, cookies, provider responses, or textbook
data in the repository.

## Installation and update

Use npm and the committed lockfile:

```bash
npm ci
npm run build
```

For a first installation, adapt and install copies of the files below:

- `ops/systemd/textbook-proofreading-api.service`
- `ops/systemd/textbook-proofreading-backup.service`
- `ops/systemd/textbook-proofreading-backup.timer`
- `ops/nginx/textbook-proofreading.example.conf`

Test Nginx before reloading it. On later code-only deployments, do not reinstall
host-specific templates unless their intended change has been reviewed.

## Nginx boundary

The template terminates HTTPS, serves the SPA, and proxies `/api/`. It clears
`Authorization`; the application trusts only its opaque session cookie. It
overwrites `X-Real-IP` with the actual client address. Keep the Node listener on
loopback so a remote caller cannot supply a trusted proxy identity directly.

## Storage and backups

Runtime directories should be mode 700 and runtime files mode 600. The Node
service is the only HTTP path to textbook data.

`ops/backup-workbench.sh` archives only durable `documents/` and `metadata/`
data, excludes resumable upload sessions, writes a SHA-256 sidecar and manifest,
and retains the newest seven successful archives. Configure `PROJECT_ROOT`,
`STORAGE_ROOT`, and `BACKUP_ROOT` in the installed unit when host paths differ.

`ops/verify-backup.sh` verifies and parses an archive in a temporary directory;
it never replaces production storage.

## Production validation

Run the validator with host-specific values supplied externally:

```bash
sudo BASE_URL=https://your-workbench.example \
  AUTH_ENV_FILE=/path/to/private/auth.env \
  ops/validate-production.sh
```

The validator uses a generated synthetic PDF, exercises session authentication,
chapter-scoped persistence, range reads, restart recovery, and cleanup. It must
never upload a real or unpublished textbook.

Provider production smoke scripts make real external requests and are not part
of ordinary deployment validation. Run them only with explicit authorization.

Before and after deployment, compute read-only aggregate counts and checksums
for document metadata, chapter metadata, proofreading workspaces, and AI review
workspaces. A code-only deployment must leave all four unchanged.
