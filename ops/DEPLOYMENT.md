# Production deployment

This deployment keeps the existing file-backed persistence and runs exactly
one Node API process. The supported topology is:

```text
HTTPS + shared Basic Auth
        |
      Nginx
   /          \\
Vue dist       /api reverse proxy
                  |
          Node API on 127.0.0.1:8787
                  |
        private file-backed storage
```

The actual Nginx, systemd, htpasswd, storage, and backup paths are host
configuration. Only the templates and scripts in this directory belong in
Git. Never commit `/etc/nginx/.htpasswd-proofread`, a password, a password
hash, production storage, backups, PDFs, or environment secrets.

## Shared access model

The shared Basic Auth username is `proofreader`. It only gates entry to the
internal workbench. It does not identify a person, enforce `assigneeName`, or
populate issue reviewer fields. There is no personal account or RBAC system in
this deployment.

Concurrency remains scoped by `documentId + chapterId + revision`:

- different chapters have independent workspace files, locks, and revisions;
- stale writes to the same chapter still return HTTP 409;
- seven people using the same Basic Auth account do not become one revision
  key and do not create cross-chapter conflicts;
- the file-backed lock assumes one Node process, so do not run a second API
  worker or cluster.

## First-time installation

Run from the project directory as `ubuntu`:

```bash
npm ci
npm run build
```

Install the service templates as root, then start the API and daily backup
timer:

```bash
sudo install -o root -g root -m 644 ops/systemd/textbook-proofreading-api.service /etc/systemd/system/textbook-proofreading-api.service
sudo install -o root -g root -m 644 ops/systemd/textbook-proofreading-backup.service /etc/systemd/system/textbook-proofreading-backup.service
sudo install -o root -g root -m 644 ops/systemd/textbook-proofreading-backup.timer /etc/systemd/system/textbook-proofreading-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now textbook-proofreading-api
sudo systemctl enable --now textbook-proofreading-backup.timer
```

Create the shared credential interactively in the SSH terminal. Do not send
the password to an automation agent and do not put it in shell history:

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-proofread proofreader
sudo chown root:www-data /etc/nginx/.htpasswd-proofread
sudo chmod 640 /etc/nginx/.htpasswd-proofread
```

The Nginx example intentionally contains no credential or hash. Before
installing it, save the current site file with a timestamp, install the
example, run `sudo nginx -t`, and reload Nginx only after that test passes.

The `/.well-known/acme-challenge/` location is unauthenticated because the
current Certbot setup uses the Nginx authenticator. All other HTTP traffic is
redirected to HTTPS, and the HTTPS server block protects both static content
and `/api/` with the shared credential.

## Storage and backups

`storage/` is owned by `ubuntu:ubuntu`; directories use mode 700 and files
use mode 600. Nginx never reads storage directly. The Node API reads it after
the request has passed through Nginx authentication.

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

## Validation

The API must show only `127.0.0.1:8787` in `ss -lntp`; port 5173 must not be
listening. Validate the public path through the real HTTPS domain, not only
the loopback API:

- no credential: `/` and `/api/documents` return 401;
- with the shared credential: `/` and `/api/documents` return 200;
- PDF GET/HEAD return 200 and expose `Accept-Ranges`, `ETag`, and
  `Last-Modified`;
- `Range: bytes=0-99` returns 206 with `Content-Range`;
- matching `If-None-Match` takes precedence and returns 304;
- matching strong ETag or fresh HTTP-date `If-Range` permits 206;
- stale or unrecognised `If-Range` safely falls back to a complete 200;
- restarting `textbook-proofreading-api` preserves documents, chapters,
  annotations, issues, and per-chapter revisions.

For a complete synthetic end-to-end check, run
`ops/validate-production.sh` from an interactive SSH terminal. It reads the
shared credential without echoing it, creates its own two-page fixture, and
removes all temporary files on exit. It does not use or upload an unpublished
textbook.

Use only synthetic, public, or open-access PDFs for deployment smoke tests.
Do not upload an unpublished textbook during validation.
