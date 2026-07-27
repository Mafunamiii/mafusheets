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
  npm run account -- create-user --login director --display-name "Choir Director" --role admin
```

There is no default account or password and no public registration route. Account commands also support
`list-users`, `disable-user --id ID`, `enable-user --id ID`,
`reset-password --id ID`, and `change-role --id ID --role admin|member`. Supply replacement
passwords through `MAFUSHEETS_NEW_PASSWORD`. Password resets revoke active sessions and require
the user to change the temporary password unless `--no-required-change` is explicitly supplied.
The final enabled administrator cannot be disabled or demoted.

## Run with Docker Compose

```bash
docker compose up --build
```

Compose also reads the same `.env` file, so the same values work in both local and container runs.

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


## Deployment

The repository includes a portable `deploy.sh` that defaults to:

- values from `.env`

Examples:

```bash
./deploy.sh
./deploy.sh --skip-install
./deploy.sh --pull
```

If you want to override any setting, export it before running the script or pass a different `ENV_FILE`:

```bash
REMOTE_HOST=deploy@159.223.66.236 APP_NAME=mafusheets ./deploy.sh
ENV_FILE=.env.production ./deploy.sh
```

## Storage

The app stores files in:

- `uploads/documents`
- `uploads/photos`
- `uploads/slides`
- `data/mafusheets.sqlite`

Back up `uploads/` and the SQLite database together.

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
