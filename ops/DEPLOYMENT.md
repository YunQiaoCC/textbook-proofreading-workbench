# Production deployment

This deployment keeps the existing file-backed persistence and runs exactly
one Node API process. The supported topology after the authentication cutover
is:

```text
HTTPS
  |
Nginx
  |-- Vue static bundle and /login
  `-- /api reverse proxy
          |
    Node application authentication
    opaque HttpOnly session cookie
          |
    private file-backed storage
```

Unauthenticated visitors may download `index.html`, JavaScript, CSS, and the
login view. Nginx never serves textbook storage. Every product `/api/*` route,
including PDF GET and HEAD, requires a valid Node-side session. Only
`POST /api/auth/login`, `GET /api/auth/session`, and `POST /api/auth/logout`
are public API routes.

The actual Nginx, systemd, secret, storage, and backup paths are host
configuration. Only templates and scripts belong in Git. Never commit a
password, password hash, session ID, production storage, backups, PDFs, or
environment secrets.

## Shared access model

There is exactly one shared workbench account: username `proofreader` plus one
shared password. Seven people can log in concurrently. Each browser receives
an independent random server-side session, and logging out one browser does
not invalidate the others.

This account answers only whether a request may enter the workbench. There are
no personal users, display names, registration, RBAC, JWTs, or user database.
The chapter workflow identity remains `Chapter.assigneeName`; human-created
issue reviewers and AI-resolution reviewers must continue to use the selected
chapter assignee, never the shared login username.

Sessions are held only in the memory of the single Node process for seven days.
Restarting the API invalidates all sessions and requires everyone to log in
again. Document, chapter, annotation, issue, and review persistence is
unaffected.

Concurrency remains scoped by `documentId + chapterId + revision`:

- different chapters have independent workspace files, locks, and revisions;
- stale writes to the same chapter still return HTTP 409;
- shared authentication does not become a revision or reviewer identity;
- the file-backed lock assumes one Node process, so do not run a second API
  worker or cluster.

## Authentication secret

Production loads the shared credential from
`/etc/textbook-proofreading/auth.env`:

```text
WORKBENCH_ACCESS_USERNAME=proofreader
WORKBENCH_ACCESS_PASSWORD=<secret>
```

Create that file only during the production cutover, outside the repository,
owned by root and readable only as required by systemd. The API unit sets
`WORKBENCH_AUTH_REQUIRED=1` and deliberately uses the required form
`EnvironmentFile=/etc/textbook-proofreading/auth.env`. If the file, username,
or password is missing, the service must fail closed instead of starting an
unauthenticated API.

The session cookie is named `proofread_session` and contains only a 32-byte
random opaque ID. It is `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to `/`,
and has a `Max-Age` aligned with the seven-day server TTL.

## First-time installation

Run from the project directory as `ubuntu`:

```bash
npm ci
npm run build
```

After the authentication secret has been created during cutover, install the
service templates as root, then start the API and daily backup timer:

```bash
sudo install -o root -g root -m 644 ops/systemd/textbook-proofreading-api.service /etc/systemd/system/textbook-proofreading-api.service
sudo install -o root -g root -m 644 ops/systemd/textbook-proofreading-backup.service /etc/systemd/system/textbook-proofreading-backup.service
sudo install -o root -g root -m 644 ops/systemd/textbook-proofreading-backup.timer /etc/systemd/system/textbook-proofreading-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now textbook-proofreading-api
sudo systemctl enable --now textbook-proofreading-backup.timer
```

## Yuandian retrieval

Store the production Yuandian credential outside Git at
`/etc/textbook-proofreading/yuandian.env` using this format:

```text
YUANDIAN_API_KEY=<secret>
```

The API service loads it through
`EnvironmentFile=-/etc/textbook-proofreading/yuandian.env`. The leading `-`
remains intentional for this optional integration: missing Yuandian
configuration is reported as `provider_unavailable` instead of preventing the
core API from starting.

After installing the unit and restarting the API, run the production smoke as
the `ubuntu` user. On Node versions that support `--env-file`, use:

```bash
node --env-file=/etc/textbook-proofreading/yuandian.env scripts/smoke-yuandian-production.mjs
```

The smoke performs one direct article retrieval and prints only sanitized
status fields. It never prints the secret, evidence body, or provider record
ID value. Do not copy the environment file or its contents into the repository.

## Nginx boundary

The Nginx template terminates HTTPS, serves the Vue SPA, and proxies `/api/`.
It contains no Basic Auth directives and sends no `X-Authenticated-User`.
It explicitly clears `Authorization`; Node trusts only `proofread_session`.
The ACME challenge, SPA fallback, and PDF.js `.mjs` handling remain intact.

Before installing a changed Nginx template, save the current site file with a
timestamp, install the example, run `sudo nginx -t`, and reload only after that
test passes.

## Storage and backups

`storage/` is owned by `ubuntu:ubuntu`; directories use mode 700 and files use
mode 600. Nginx never reads storage directly. The authenticated Node API is the
only HTTP path to textbook data.

`ops/backup-workbench.sh` archives only `storage/documents/` and
`storage/metadata/`. It excludes `storage/temp/`, writes a timestamped archive,
SHA256 sidecar, and manifest, then retains the newest seven successful
archives. Pruning happens only after the new archive and metadata have been
written successfully. The backup root is outside the repository and must use
mode 700, with archives and manifests at mode 600.

`ops/verify-backup.sh` verifies the checksum, extracts into a temporary
directory, checks `documents/` and `metadata/`, and parses every JSON metadata
file. It never replaces production storage.

This is a file-level snapshot, not a database transaction spanning every
chapter. Immutable document assets and atomic metadata writes make that level
of consistency acceptable for the current chapter-scoped seven-person
workflow.

## Production cutover and validation

Do not partially adapt `ops/validate-production.sh` while production still
uses Nginx Basic Auth. In the dedicated cutover round:

1. create `/etc/textbook-proofreading/auth.env`;
2. install the new build and systemd unit;
3. while the old Basic Auth gate still protects the site, verify Node login,
   session, logout, protected API, and PDF behavior;
4. install the Nginx template that removes Basic Auth;
5. run `nginx -t`;
6. reload Nginx;
7. run public login/logout plus unauthenticated 401 and authenticated 200
   smoke checks.

Update `ops/validate-production.sh` to the session model as part of that same
cutover. Use only synthetic, public, or open-access PDFs for deployment smoke
tests; never upload an unpublished textbook during validation.
