# MafuSheets

MafuSheets is a personal music sheet library and viewer for PDFs, images, and chord charts.

## What it does

- Upload and organize music sheets
- Tag entries with fully custom labels
- Store page-based annotations
- Search by title, artist, tags, notes, filename, and extracted text
- Preview PDFs, images, and text-based chord charts in the browser
- Use a built-in visual metronome for rehearsal or mass
- Sign in as an admin to access the entire library, reader, uploads, downloads, and maintenance tools

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

The server loads `.env` automatically if it exists. Use `.env.example` as the template for local runs and deployments.
`SESSION_SECRET` is required and must be a persistent, non-placeholder value of at least 32
characters. Generate one with `openssl rand -base64 48`. Startup fails closed when it is missing
or weak; changing it invalidates all session cookies.
Supply the initial account password only for the account command:

```bash
MAFUSHEETS_NEW_PASSWORD='choose-a-strong-unique-password' \
  npm run account -- create-user --login director --display-name "Choir Director" \
    --role admin --emergency-system-actor
```

There is no default account or password and no public registration route. Account commands also support
`list-users`, `disable-user --id ID`, `enable-user --id ID`,
`reset-password --id ID`, and `change-role --id ID --role admin|member`. Supply replacement
passwords through `MAFUSHEETS_NEW_PASSWORD`. Password resets revoke active sessions and require
the user to change the temporary password unless `--no-required-change` is explicitly supplied.
The final enabled administrator cannot be disabled or demoted.

Every account-changing command requires exactly one attribution mode. Normally use
`--operator LOGIN_OR_ID`, which must resolve to an enabled administrator:

```bash
npm run account -- disable-user --id AFFECTED_USER_ID --operator director
```

`--emergency-system-actor` is reserved for the first administrator or documented local recovery.
It records the stable, disabled, non-login emergency actor and a conspicuous emergency mode in the
audit event. The affected account remains the event entity. Never place passwords on the command
line; use `MAFUSHEETS_NEW_PASSWORD`.

## Run with Docker Compose locally

```bash
docker compose up --build
```

The production Compose file requires HTTPS certificates and is intentionally not a plain-HTTP
development stack. Copy `.env.production.example` to a protected `.env`, supply real values, and
follow the production deployment section below.

The admin panel also includes a "Refresh thumbnails" action for older entries that were created before thumbnails were generated automatically.

## Upload safety defaults

Uploads use private staging storage, content signatures, declared MIME checks, structural validation,
per-user quotas, and isolated processing workers. The default limits are:

- 50 MiB per file
- 150 MiB for the complete multipart request
- 10 files per request
- 2 GiB live storage per user
- 500 MiB uploaded per user in a rolling 24-hour period
- one concurrent upload per user and two processing workers
- 30 seconds and 192 MiB of JavaScript heap per isolated worker
- 500 PDF pages and 40 million image pixels
- two processing attempts; jobs never retry indefinitely

Configure these with `UPLOAD_MAX_FILE_BYTES`, `UPLOAD_MAX_REQUEST_BYTES`,
`UPLOAD_MAX_FILES`, `UPLOAD_USER_STORAGE_BYTES`, `UPLOAD_USER_DAILY_BYTES`,
`UPLOAD_USER_CONCURRENCY`, `UPLOAD_WORKER_CONCURRENCY`, `UPLOAD_PROCESS_TIMEOUT_MS`,
`UPLOAD_REQUEST_TIMEOUT_MS`, `UPLOAD_MAX_PDF_PAGES`, and `UPLOAD_MAX_IMAGE_PIXELS`. Unsafe zero, malformed, and
overly large values stop startup. The daily allowance can be disabled only with the explicit value
`disabled`.

Set `UPLOADS_DIR`, `TMP_DIR`, and `THUMB_DIR` to storage outside the application source tree in
production. The Docker volumes already keep persistent uploads and staging separate from the image.
The reverse proxy should reject request bodies above 150 MiB (for nginx:
`client_max_body_size 150m`) and use an upload timeout no greater than the application's operational
requirements.

Staging files older than 24 hours are conservatively removed at startup. Recent files, directories,
symlinks, and files known to an active request are not removed. Administrators can run the same safe
cleanup explicitly:

```bash
npm run integrity -- --cleanup-staging
```

Accepted resources may briefly show pending search and thumbnail state while their attributable,
bounded background job runs. Job states are persisted and interrupted jobs receive at most one retry.

The Batch 4 dependency audit is stored in `audit-batch4.json`. The final production audit reports
zero known vulnerabilities. Multer is on the maintained 2.x line, Sharp was upgraded to the patched
0.35 line, and the unused legacy SheetJS spreadsheet parser was removed because its published
high-severity issues had no compatible registry fix. Spreadsheet files were not accepted by the HTTP
upload policy; existing spreadsheet resources now retain their files but no longer receive extracted
spreadsheet search text during reindexing.


## Production deployment

The supported production baseline is Docker Compose with nginx as the only published service:

```text
browser --HTTPS--> nginx --private Docker network--> Node
```

Node has no host port. nginx publishes HTTP only to redirect it to HTTPS and publishes the HTTPS
endpoint on `HTTPS_BIND_IP`. Set this to `0.0.0.0` for an ordinary public host, `127.0.0.1` when
another local ingress owns the public socket, or a specific Tailscale/private address. Regardless
of address choice, browsers connect to nginx over HTTPS. Do not expose the Node container port.

The proxy network is fixed at `172.30.0.0/24`; Express trusts forwarded protocol and client
information only from nginx's fixed `172.30.0.20` address. If the subnet or proxy address changes,
update Compose IPAM and `TRUST_PROXY` together. nginx replaces rather than appends inbound
forwarding headers, preventing clients from supplying a forged address chain. `PUBLIC_ORIGIN` must
be the canonical HTTPS origin.

Prepare production configuration:

```bash
cp .env.production.example .env
chmod 600 .env
# Replace every placeholder, then verify:
./deploy.sh --verify
```

The TLS private key should be readable by nginx's container UID 101 without becoming
world-readable. Where certificate-management permissions make that impractical, provision a
root-owned, narrowly readable deployment copy rather than weakening the original key.

The Compose stack uses:

- a non-root Node runtime (UID/GID 1000);
- a non-root nginx runtime (UID/GID 101);
- read-only container root filesystems;
- dropped capabilities and `no-new-privileges`;
- explicit database, upload, thumbnail, staging, and quarantine volumes;
- bounded `/tmp` and nginx cache tmpfs mounts;
- CPU, memory, and PID limits;
- a one-shot storage initializer that grants only the application UID mode `0700` access;
- liveness and deeper readiness probes.

SQLite files, WAL/SHM files, migration backups, uploads, thumbnails, staging, and quarantine data
remain inside their dedicated volumes. Back up the database volume and uploads together. Backup
files created by maintenance commands inherit the private database directory and are explicitly
set read-only by the application. Runtime logging goes only to stdout/stderr; no writable
application log directory is required. Configure the container runtime's log rotation.

Existing root-owned Docker volumes must be started through `docker compose up`; the `storage-init`
service changes only the five named storage volumes to UID/GID 1000 and mode `0700`. Take a backup
before the first migration. The previous PM2 deployment is no longer the secure production
baseline because its external proxy, Node version, port exposure, and filesystem permissions were
not repository-controlled.

The image follows the supported Node 22 LTS major line. Rebuild regularly to receive Node and
Alpine security patches; review and deliberately update the major tag when moving to a newer LTS.
Production dependencies are installed reproducibly with `npm ci --omit=dev`.

### HTTPS and browser security

nginx redirects HTTP with status 308, accepts TLS 1.2/1.3, and initially emits HSTS for one day.
It deliberately does not use `includeSubDomains` or `preload`. Increase the duration only after
confirming HTTPS operation and certificate renewal. Production startup requires secure session
cookies. Cookies remain `HttpOnly`, `SameSite=Lax`, host-only, scoped to `/`, and expire after
twelve hours. Session and CSRF tokens are never placed in URLs or browser storage.

State-changing routes retain the Batch 2 session-bound `X-CSRF-Token` validation and same-origin
check. Correct forwarded HTTPS recognition is therefore required and is covered by tests.

nginx accepts at most 157,286,400 bytes, matching `UPLOAD_MAX_REQUEST_BYTES`, and streams request
bodies to avoid unbounded proxy temporary files. If the application limit changes, update
`client_max_body_size` in `nginx/nginx.conf` in the same change. Authenticated HTML, APIs, files,
and thumbnails are never publicly cached. Thumbnails use a five-minute private browser cache;
static logos use a one-hour public cache.

Dotfiles, environment files, databases, backups, source maps, storage paths, staging paths, and
the deeper `/ready` endpoint are blocked at nginx. Application admin routes remain available only
through their existing authenticated role and CSRF controls.

### Health checks

`/health` is a minimal process liveness endpoint. The internal `/ready` endpoint verifies:

- a live SQLite query;
- safe create/fsync/delete probes in the database, upload, thumbnail, staging, and quarantine
  directories;
- executable `pdfinfo` and `pdftoppm` dependencies;
- presence of the isolated worker program;
- the startup integrity result.

The probes use unique mode-`0600` empty files and remove them immediately; they never touch user
content. nginx does not expose `/ready`. A missing dependency, read-only storage volume, database
failure, or startup integrity problem makes readiness return HTTP 503.

### Verification and deployment

`./deploy.sh` performs verification by default and never deploys without `--apply`. Verification
checks required settings, certificate readability, Compose validity, and Dockerfile build checks.
For a deliberate remote update:

```bash
./deploy.sh --verify
./deploy.sh --apply
./deploy.sh --pull
```

After startup, verify the deployed endpoint:

```bash
curl -I http://HOST/                         # 308 to https://
curl -k https://HOST/health                  # 200
docker compose ps                            # app and nginx healthy
docker compose exec mafusheets id            # uid=1000
docker compose exec mafusheets sh -c 'test ! -w /app/server.js'
docker compose exec mafusheets wget -qO- http://127.0.0.1:3000/ready
./scripts/verify-running.sh
```

Confirm from a separate host that only the configured nginx ports are reachable; port 3000 must
not be reachable. Test login through HTTPS and inspect `Set-Cookie` for `Secure`, `HttpOnly`,
`SameSite=Lax`, `Path=/`, and the twelve-hour lifetime. Also confirm that `/.env`,
`/data/mafusheets.sqlite`, `/backup.sqlite`, `/app.js.map`, and `/ready` return 404, and that an
oversized request receives 413.

## Storage

The app stores files in:

- `uploads/documents`
- `uploads/photos`
- `uploads/slides`
- `data/mafusheets.sqlite`

Back up `uploads/` and the SQLite database together.

### Paired backup, restore, and rollback

Stop or quiesce application writes before taking a paired backup. The command refuses to proceed
without the explicit `--quiesced` acknowledgement:

```bash
npm run backup -- --quiesced \
  --database /isolated/data/mafusheets.sqlite \
  --uploads /isolated/uploads \
  --output /isolated/backups/2026-07-27 \
  --release 8A --image mafusheets:8A --config-id choir-production-v1
```

The backup directory contains an SQLite backup-API snapshot, the uploads tree, and a manifest with
schema/release identifiers, modes, ownership metadata, sizes, and SHA-256 checksums. It includes
only explicitly selected data, so session secrets, TLS keys, staging, worker output, and unrelated
runtime artifacts are excluded.

Restore defaults to a nonexistent database and an empty or nonexistent uploads directory. It
verifies every checksum and path before writing, then runs SQLite integrity and resource/file
reconciliation:

```bash
npm run restore -- \
  --source /isolated/backups/2026-07-27 \
  --database /isolated/restore/mafusheets.sqlite \
  --uploads /isolated/restore/uploads
```

Create a rollback plan from previously recorded non-secret release metadata:

```bash
npm run rollback -- \
  --previous /isolated/releases/previous.json \
  --current /isolated/releases/failed.json \
  --output /isolated/releases/rollback-plan.json
```

All commands emit a one-line JSON result on stdout and a human summary on stderr. They refuse
symlinks, traversal, roots, ambiguous destinations, and existing restore databases.

### Release validation

```bash
npm test
npm run test:batch8a
npm run test:failure
npm run rehearse:backup
npm run test:browser
npm run lint
npm run static-check
npm run validate
```

Playwright provides `chromium-desktop` at 1280×800 and `chromium-mobile` at 390×844. Its server
fixture creates a fresh temporary database and storage tree and never uses configured live data.
Browsers are development dependencies only and are not copied into the production image.

Batch 8A failure tests use temporary directories, child processes, and direct test-only module
hooks. No fault-injection switch or ordinary HTTP request can activate them in production.

Resource uploads and replacements are staged before their database commit. Deletions move required
artifacts into `data/quarantine` before the resource is marked deleted and only report success after
cleanup completes. Failed operations remain visible to the integrity reporter:

```bash
npm run integrity
npm run integrity -- --repair
npm run integrity -- --repair-operation OPERATION_ID
```

The general repair mode creates missing storage directories and removes only expired operation
locks; it does not delete suspicious files. Operation-specific deletion repair requires an ID from
the report and creates a read-only SQLite backup before making changes.

On first startup, an existing `data/resources.json` is validated and imported transactionally. The
original bytes are retained in a read-only `data/resources.json.migration-backup-*.json` file, and
the JSON catalog is never written again. Invalid JSON, duplicate IDs, or conflicting stored paths
stop startup without creating an empty successful library.

## Notes

- Annotations are page-based, not coordinate-based.
- The metronome is visual only, so it works in quiet settings.
- The whole app is behind login now; unauthenticated visitors only see the login screen.
- Session identifiers are stored only as keyed hashes. Audit records use a short keyed client
  fingerprint for abuse investigation rather than retaining raw IP addresses.
- Chord-providing website content is best saved as text, PDF, or a user-managed export that you upload here.
- On tablets and smaller screens, use the separate Add sheet tab instead of keeping the upload form visible beside the library.
