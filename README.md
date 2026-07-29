# MafuSheets

MafuSheets is a personal music sheet library and viewer for PDFs, images, and chord charts.

## What it does

- Upload and organize music sheets
- Tag entries with fully custom labels
- Store page-based annotations
- Search by title, artist, tags, notes, filename, and extracted text
- Preview PDFs, images, and text-based chord charts in the browser
- Use a built-in visual metronome for rehearsal or mass
- Browse documents that administrators publish to the guest library without signing in
- Create an account and browse the guest library while membership approval is pending
- Access restricted documents, uploads, and annotations after administrator approval
- Sign in as an admin to approve accounts, publish guest documents, and use maintenance tools

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

There is no default account or password. Visitors can self-register; new accounts are enabled but remain
pending until an administrator approves them. Pending accounts can browse guest-visible documents and
manage their profile, but cannot access restricted documents, upload, or annotate. Administrators can
approve, suspend, and manage accounts from **Account → Admin → Accounts**. Account commands also support
`list-users`, `disable-user --id ID`, `enable-user --id ID`,
`reset-password --id ID`, and `change-role --id ID --role admin|member`. Supply replacement
passwords through `MAFUSHEETS_NEW_PASSWORD`. Password resets revoke active sessions and require
the user to change the temporary password unless `--no-required-change` is explicitly supplied.
The final enabled administrator cannot be disabled or demoted.

All uploads are restricted to approved members by default. Members cannot publish documents themselves.
An administrator can use a document's **Publish to guest library** action to make its preview and download
available without an account, and can later remove it from the guest library. Existing documents remain
restricted when upgrading.

Every account-changing command requires exactly one attribution mode. Normally use
`--operator LOGIN_OR_ID`, which must resolve to an enabled administrator:

```bash
npm run account -- disable-user --id AFFECTED_USER_ID --operator director
```

`--emergency-system-actor` is reserved for the first administrator or documented local recovery.
It records the stable, disabled, non-login emergency actor and a conspicuous emergency mode in the
audit event. The affected account remains the event entity. Never place passwords on the command
line; use `MAFUSHEETS_NEW_PASSWORD`.

Signed-in users can update their own display name from the Account panel after confirming their
current password. Administrators can also update account login identifiers and display names.
Account IDs remain stable so ownership and audit history are preserved.

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
  --application-commit 0123456789abcdef0123456789abcdef01234567 \
  --image-digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --bundle-id 20260729T031500Z-0123456789abcdef01234567 \
  --config-id choir-production-v1
```

The backup directory contains an SQLite backup-API snapshot, the uploads tree, and a version-2
manifest with
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

Verify a paired backup in place without modifying it:

```bash
npm run verify-backup -- --source /isolated/backups/2026-07-27
```

### Tailscale off-site backups

The maintained small-system design and installation guide is
[ops/offsite-backup/README.md](ops/offsite-backup/README.md). It uses packaged `rrsync`, one
root-side Python receiver, root-owned archive/quarantine, separate disabled-by-default retention,
and a direct restore tool.

<details>
<summary>Superseded enterprise design (historical; do not install)</summary>

Production is treated as fully untrusted. It creates one dependency-free MafuSheets bundle and
streams it through OpenSSH over Tailscale. The backup key is forced to a narrow ingestion utility;
the client cannot execute shell commands or select server-side paths. The utility accepts only:

```text
put YYYYMMDDTHHMMSSZ-24_HEX_CHARACTERS.bundle SIZE SHA256
```

It writes a randomly named hidden partial with `O_EXCL`, enforces the declared/configured size,
checks SHA-256, calls `fsync`, and publishes the final mode-`0400` file with an atomic no-overwrite
hard link. Failed and partial transfers never appear as `.bundle` files.

A root receiver first detaches completed bundles into protected work storage and replaces their
inode to discard sender-controlled metadata. A separate, unprivileged `mafusheets-verifier` account
checks the manifest, every file checksum, SQLite integrity, and database-to-upload reconciliation.
It can write only pending, verified, rejected, temporary, and runtime-lock paths; it cannot access
incoming, archive, or quarantine. A small root promoter then constructs a
new archive tree without preserving ownership, modes, ACLs, extended attributes, timestamps,
reflinks, or sparse-file metadata. It enforces `root:root`, mode `0400`/`0500`, and atomically
publishes that tree. Invalid bundles are moved to quarantine. Retention is a separate service and is
disabled by default.

#### Production installation

1. Install Tailscale, OpenSSH client, Python 3, OpenSSL, and `flock`, and connect the machine to the
   tailnet.
2. Create a dedicated Ed25519 SSH key used only for this backup destination.
3. Pin the home server's SSH host key in the production user's `known_hosts`; the sender deliberately
   requires strict host-key checking.
4. Copy `ops/offsite-backup/offsite-backup.env.example` to
   `/etc/mafusheets/offsite-backup.env`, fill in the Tailscale hostname and release values, make it
   owned by the service account (`deploy` in the supplied unit) and mode `0600`.
5. Install the production service and timer:

   ```bash
   sudo install -m 0644 ops/offsite-backup/mafusheets-offsite-backup.service \
     /etc/systemd/system/
   sudo install -m 0644 ops/offsite-backup/mafusheets-offsite-backup.timer \
     /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now mafusheets-offsite-backup.timer
   ```

The supplied service runs as `deploy`; change `User`, `Group`, project path, and SSH key path if the
production deployment uses another account. That account must be able to control the Docker Compose
project. Backup creation briefly stops only the application container, restarts it before network
transfer, and has an exit trap that attempts to restart it after failures.

#### HomeServer ingestion boundary

Install the forced ingestion utility and create the directories:

```bash
sudo install -o root -g root -m 0755 scripts/mafusheets-backup-ingest \
  /usr/local/libexec/mafusheets-backup-ingest
sudo install -o root -g root -m 0644 ops/offsite-backup/mafusheets-backup-tmpfiles.conf \
  /etc/tmpfiles.d/mafusheets-backup.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/mafusheets-backup.conf
```

The `mafusheets-backup` account must not control its home, SSH policy, authorized keys, ingestion
utility, receiver, or any parent of `incoming`. Give it a minimal shell for forced-command execution:

```bash
sudo usermod --shell /bin/dash mafusheets-backup
```

Copy `ops/offsite-backup` to a root-controlled staging location on the HomeServer. Run the installer
with the production VPS's Ed25519 **public** key:

```bash
sudo chmod 0755 ops/offsite-backup/install-backup-ssh-hardening.sh
sudo ops/offsite-backup/install-backup-ssh-hardening.sh \
  /root/mafusheets-production-backup.pub
```

The installer makes the account home, its existing `.ssh` tree, and recognized shell startup files
root-owned and non-writable by the account. It installs the key at
`/etc/ssh/authorized_keys/mafusheets-backup`, installs the `Match User` policy, and runs `sshd -t`
against the complete configuration (plus an effective-configuration parse for the backup user). It
aborts and restores the prior SSH files if validation fails. The resulting key retains this complete
forced-command prefix:

```text
restrict,command="/usr/local/libexec/mafusheets-backup-ingest --incoming /var/spool/mafusheets-backup/incoming --max-bytes 21474836480 --max-count 4 --min-free-bytes 5368709120 --lock-file /var/spool/mafusheets-backup/.ingest.lock" ssh-ed25519 AAAA... mafusheets-production-backup
```

The key cannot list, delete, overwrite, or rename bundles and cannot run arbitrary commands. The
installer intentionally does **not** reload SSH. Keep the current administrative session open,
inspect its success output, and reload only after validation succeeds:

```bash
sudo sshd -t
sudo systemctl reload ssh
```

Do not install the example authorized-keys file literally without replacing its placeholder key.
After installation, confirm that an arbitrary command is rejected:

```bash
ssh -i /path/to/production-key mafusheets-backup@100.93.39.106 id
```

The response must be `ingest rejected: invalid protocol request`, never command output.

Every SSH file changed by the installer has a root-only snapshot. Its success output prints the
unique snapshot directory. To restore both the previous key file and previous sshd drop-in:

```bash
sudo ops/offsite-backup/install-backup-ssh-hardening.sh --rollback \
  /etc/ssh/mafusheets-backup-rollback/<snapshot>
sudo sshd -t
sudo systemctl reload ssh
```

The rollback validates the restored configuration and does not reload it. Keep the original
administrator session open until the restricted login test succeeds. The installer does not modify
the main `/etc/ssh/sshd_config`; if the key or drop-in was newly introduced, rollback removes it.

#### HomeServer receiver

Install GNU coreutils, Python 3, and the Debian `acl` package on the HomeServer. The receiver does
not require a MafuSheets checkout, Node.js, npm, `better-sqlite3`, or application dependencies.
Copy a release archive containing `scripts/` and `ops/offsite-backup/` to a root-controlled
staging directory, verify its checksum, and install the independently versioned verifier and
pipeline:

```bash
sudo apt-get install --no-install-recommends acl python3
sudo chmod 0755 ops/offsite-backup/install-home-server-tools.sh
sudo ops/offsite-backup/install-home-server-tools.sh
sudo /usr/local/libexec/mafusheets-backup-verifier --version
sudo systemctl enable --now mafusheets-backup-receiver.timer
```

Verifier `1.0.0` uses only the Python standard library. It parses the bundle itself, applies
bounded extraction, validates the complete manifest inventory and hashes, and opens the extracted
SQLite snapshot with `mode=ro&immutable=1`. It runs integrity and foreign-key checks, validates
the expected table/column contract for schema versions 1 through 6, and reconciles live
`resource_files` rows with uploaded files. It never imports application code or runs migrations.
It writes exactly one JSON result line to stdout and a human-readable result to stderr.

The Python implementation is an interim self-contained operational artifact. Its CLI and JSON
contract are the compatibility boundary for a future static Go or Rust replacement. Update
`ops/offsite-backup/VERIFIER_VERSION`, the embedded verifier version, compatibility handlers,
tests, and installer expectation together for every verifier release.

The expected home-server directories are:

```text
/var/spool/mafusheets-backup/incoming mafusheets-backup:mafusheets-backup 0700
/var/lib/mafusheets-backup/work       root:mafusheets-verifier           0710
/var/lib/mafusheets-backup/work/pending mafusheets-verifier:mafusheets-verifier 0700
/var/lib/mafusheets-backup/work/verified mafusheets-verifier:mafusheets-verifier 0700
/var/lib/mafusheets-backup/work/rejected mafusheets-verifier:mafusheets-verifier 0700
/var/lib/mafusheets-backup/tmp        mafusheets-verifier:mafusheets-verifier 0700
/var/lib/mafusheets-backup/catalog    root:root                           0700
/var/lib/mafusheets-backup/catalog/catalog.jsonl root:root                0600
/srv/backups/mafusheets/archive     root:root                           0750
/srv/backups/mafusheets/quarantine  root:root                           0700
/run/mafusheets-backup              root:mafusheets-verifier           0770
```

Normal pipeline output goes to journald; no sender-adjacent log directory is used. The format
contract is maintained independently in `ops/offsite-backup/BACKUP_FORMAT.md` and is installed as
`/usr/local/share/doc/mafusheets-backup/BACKUP_FORMAT.md`.

Put incoming and archive on separate filesystems or datasets so an upload flood cannot consume
archive capacity. Mount incoming and work with `nodev,nosuid,noexec`; archive and quarantine should
also use `nodev,nosuid,noexec` when they contain backup data only. Recommended starting limits are a
25 GiB per-bundle verifier limit, a 30 GiB incoming project/user quota with at most two concurrent
bundle equivalents, and an archive quota/capacity sized for the measured daily change rate,
retention window, and at least 20% free-space reserve. Alert at 70%, 85%, and 95%. Filesystem quotas
are a second boundary; the ingestion utility's byte limit remains mandatory.

The forced receiver serializes uploads with a root-created lock, admits at most four completed
or partial bundles (`--max-count`). Each bundle is capped at 20 GiB at SSH ingestion and again
during detachment, and ingestion preserves 5 GiB free on its filesystem. Verification has a
30-minute timeout, 1 GiB `MemoryMax`, one CPU
(`CPUQuota=100%`), plus extraction, file-count, and nesting limits. Promotion requires 50 GiB and
10,000 inodes to remain free. Quarantine is logically capped at 10 GiB and preserves 50 GiB free on
its filesystem; once either limit is reached, newly rejected
attacker-controlled data is discarded and logged rather than consuming archive capacity.

The root-owned append-only JSONL catalog is
`/var/lib/mafusheets-backup/catalog/catalog.jsonl`. Its utility uses `O_APPEND`, an exclusive lock,
and `fsync`; it refuses reused bundle IDs and manifest hashes. Records include the bundle ID,
manifest creation time, configured source identity, manifest hash, deterministic archive hash,
schema version, verification result, and promotion time. Rejected IDs are recorded too. Back up
the catalog with the archive. Root can bypass Unix mode bits, so use independently administered
filesystem snapshots or an audit copy if HomeServer-root tampering is in scope.

Incoming, work, quarantine, and archive should be separate datasets or have separate hard byte and
inode quotas. Give quarantine its own roughly 12 GiB dataset/quota and incoming a 30 GiB quota.
This is required to ensure a sender can delay backups but cannot consume archive-reserved blocks.

Monitor both blocks and inodes with `df -h` and `df -ih` for spool, work, archive, and quarantine.
Alert on `incoming bundle count limit reached`, `quarantine usage limit`, `insufficient archive
free space`, `insufficient archive inodes`, unit timeouts, `ENOSPC`, and `EDQUOT`, and when no
accepted catalog record arrives during the expected backup interval. Alert at 70%, 85%, and 95%.
Byte-only monitoring is insufficient because small hostile files can exhaust inodes first.

Test both halves before enabling unattended operation:

```bash
sudo systemctl start mafusheets-offsite-backup.service
sudo journalctl -u mafusheets-offsite-backup.service

sudo systemctl start mafusheets-backup-receiver.service
sudo journalctl -u mafusheets-backup-receiver.service \
  -u mafusheets-backup-verifier.service -u mafusheets-backup-promoter.service
sudo find /srv/backups/mafusheets/archive -mindepth 3 -maxdepth 3 -type d
```

Review the sandbox after every unit or systemd upgrade:

```bash
sudo systemd-analyze security mafusheets-backup-receiver.service
sudo systemd-analyze security mafusheets-backup-verifier.service
sudo systemd-analyze security mafusheets-backup-promoter.service
sudo systemd-analyze security mafusheets-backup-retention.service
```

The installer runs these reports automatically but does not fail installation solely on a score:
scores vary by Debian/systemd release and must be reviewed by directive. Remaining intentional
exposure is narrow but non-zero. Receiver and promoter retain UID 0 because they perform ownership
transitions across mutually inaccessible accounts and filesystems. The promoter can modify archive
and quarantine; retention can delete archive entries by design. The verifier is unprivileged but
can consume CPU and disk up to configured limits while parsing attacker-controlled input (the unit
also caps it at 1 GiB memory, 32 tasks, and one CPU).
Filesystem quotas, service timeouts, independent archive snapshots, and capacity alerts remain
required controls. `ReadWritePaths` and `InaccessiblePaths` explicitly scope each service; the
common hardening set includes `NoNewPrivileges`, private devices and temporary directories, strict
system/home/kernel/control-group protection, `AF_UNIX`-only address families,
`MemoryDenyWriteExecute`, personality locking, and SUID/SGID restrictions.

On systemd 257, offline analysis of the shipped repository units produced: receiver `2.8 OK`,
verifier `1.9 OK`, promoter `2.8 OK`, and retention `2.5 OK`. Some findings remain intentional:
each unit uses the host root filesystem (made read-only by `ProtectSystem=strict`), retains
`AF_UNIX` for local libc/system integration, and does not use `PrivateUsers`, which avoids UID
mapping surprises on persistent work and archive paths. Receiver and promoter retain only
`CAP_CHOWN`, `CAP_DAC_OVERRIDE`, and `CAP_FOWNER`; verifier and retention have empty capability
bounding sets. Record the actual post-install score and directive table in HomeServer operations
notes because Debian upgrades can change analyzer scoring.

Configure the tailnet so the production tag can reach only TCP port 22 on the backup-server tag.
The HomeServer currently has Tailscale address `100.93.39.106`, but policy should use device tags
rather than depending on an address. Do not grant the production SSH account permission to write
archive, quarantine, work, logs, tmp, authorized keys, or receiver configuration.

Proposed tailnet policy (merge manually with existing grants and tag owners; do not replace an
existing policy blindly):

```json
{
  "tagOwners": {
    "tag:mafusheets-prod": ["autogroup:admin"],
    "tag:backup-server": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:mafusheets-prod"],
      "dst": ["tag:backup-server"],
      "ip": ["tcp:22"]
    }
  ],
  "tests": [
    {
      "src": "tag:mafusheets-prod",
      "accept": ["tag:backup-server:22"],
      "deny": ["tag:backup-server:80", "tag:backup-server:443"]
    }
  ]
}
```

Review and validate this in the Tailscale admin policy editor. On each node validate the applied
identity and route with `tailscale status`, `tailscale debug prefs`, and, from production,
`tailscale ping <backup-server-MagicDNS-name>`. Then run the SSH negative tests below. Tags and
grants constrain network reachability; the OpenSSH forced command remains the application-layer
boundary. Do not use `100.93.39.106` in policy or automation.

#### Recovery package

Build the immutable-input recovery package for every release:

```bash
scripts/build-recovery-package.sh \
  /isolated/releases/mafusheets-recovery-1.0.0 \
  0123456789abcdef0123456789abcdef01234567 \
  sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  /isolated/releases/mafusheets-image.oci.tar
cd /isolated/releases/mafusheets-recovery-1.0.0
sha256sum -c CHECKSUMS.sha256
```

Store the package with the archive and on a second independently administered recovery medium.
Sign `CHECKSUMS.sha256` with the organization's offline signing key when one is available. The
package contains verifier and restore binaries, the immutable offline application image, the
format and schema specifications, a blank-host runbook, deployment templates, release metadata,
and dependency inventory. It contains no
production secrets. Database encryption keys, session secrets, administrator bootstrap material,
TLS private keys, and external-service credentials must be escrowed separately in an encrypted
recovery store with independently tested access.

The rehearsal contract is: a blank Debian/Docker host, one recovery package, one `.bundle`, and the
separate secret escrow. Follow `docs/RECOVERY_RUNBOOK.md` inside the package. A release is not
recoverable merely because its archive permissions look correct; record a successful extraction,
SQLite validation, container startup, authentication, and representative document read.

#### Existing-layout migration

The installer never moves or deletes `/srv/backups/mafusheets/incoming`. Migrate without altering
existing data:

1. Disable (do not delete) the old sender/receiver timers and record their prior enablement state.
2. Install the new tools, tmpfiles policy, units, and SSH drop-in. Run `sshd -t`; do not reload yet.
3. Treat every old incoming object as untrusted. Inventory it read-only with
   `find /srv/backups/mafusheets/incoming -xdev -printf '%y %s %p\n'` and preserve a filesystem
   snapshot. Never copy it directly into archive.
4. Mount or provision `/var/spool/mafusheets-backup/incoming` with its quota. Switch only the
   forced-command destination. Keep the legacy directory root-owned and offline for manual,
   one-at-a-time verification through protected work.
5. Run unit tests, `sshd -t`, manual sender transfer, forced-command negative tests, verifier,
   promoter, ownership checks, and a blank-host recovery rehearsal. Enable only the receiver timer.
   Retention stays disabled.

Rollback each configuration layer independently:

| Change | Install | Validate / expected result | Rollback |
|---|---|---|---|
| Tools and units | `sudo ops/offsite-backup/install-home-server-tools.sh` | verifier prints `1.0.0`; unit files parse | reinstall the previously checksummed tool/unit package; `systemctl daemon-reload` |
| SSH key/drop-in | `sudo ops/offsite-backup/install-backup-ssh-hardening.sh PUBKEY` | `sudo sshd -t`; forced `id` is rejected | run installer `--rollback SNAPSHOT`; `sshd -t`; reload only after success |
| Sender unit | install supplied service/timer, but leave timer disabled | manual service sends one immutable bundle | disable unit and reinstall prior unit/environment backup |
| Spool path | switch forced command after creating new spool | completed transfer appears once as mode `0400`; no partial appears | restore SSH snapshot pointing at old receiver; do not move either spool |
| Tailnet grants | paste proposed grant manually | policy tests pass; port 22 works; denied ports fail | restore the prior tailnet policy revision in the admin console |
| Retention | no installation action enables it | `systemctl is-enabled ...` reports disabled | `systemctl disable --now mafusheets-backup-retention.timer` |

Configuration rollback never deletes archives, legacy incoming data, catalogs, or quarantine.
Keep checksummed copies of previous units and tools so rollback does not depend on the application
checkout.

#### Boundary and integration tests

Repository tests exercise valid/interrupted transfers, no-overwrite behavior, hostile container
paths/types/inventories, SQLite failures, schema/version limits, replay protection, promotion
metadata, and retention defaults:

```bash
npm run test:offsite-backup
```

After installing on production, use the tagged MagicDNS hostname (not the fixed address):

```bash
BACKUP_REMOTE_HOST=backup-server.example.ts.net \
BACKUP_SSH_KEY=/home/deploy/.ssh/mafusheets-backup \
  ops/offsite-backup/test-production-boundary.sh
sudo systemctl start mafusheets-offsite-backup.service
sudo journalctl -u mafusheets-offsite-backup.service
```

On the HomeServer:

```bash
sudo ops/offsite-backup/test-homeserver-boundary.sh
sudo systemctl start mafusheets-backup-receiver.service
sudo journalctl -u mafusheets-backup-receiver.service \
  -u mafusheets-backup-verifier.service -u mafusheets-backup-promoter.service
```

The production negative test proves the same key cannot run `id`, list/archive-access, delete,
rename, or invoke any protocol other than one `put`. The HomeServer test independently proves the
upload UID cannot read or write archive and retention is disabled. Both are required: a forced
command alone does not prove filesystem isolation, and Unix permissions alone do not prove the SSH
protocol boundary.

Retention never executes from ingestion, verification, promotion, or the receiver timer. Its timer
is installed but not enabled. Before enabling it, protect the archive independently with tested ZFS
or Btrfs snapshots, copy `backup-retention.env.example` to the root-owned mode-`0600` file
`/etc/mafusheets/backup-retention.env`, set a positive day count, and run a manual dry review of the
eligible archive paths. Only then explicitly run:

```bash
sudo systemctl enable --now mafusheets-backup-retention.timer
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

</details>

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
