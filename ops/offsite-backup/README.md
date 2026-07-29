# MafuSheets off-site backup

## What was simplified

Removed: the custom SSH ingestion protocol, separate verifier account/service, pending/verified/
rejected queues, replay catalog, standalone verifier release machinery, historical schema
handlers, recovery-package/offline-image builder, signing plans, and enterprise capacity controls.
The obsolete files are intentionally not installed.

Kept: OpenSSH over Tailscale, a root-owned authorized-key file, packaged `rrsync` forced command,
write-only/no-delete/no-overwrite incoming access, safe tar extraction, manifest SHA-256 checks,
read-only SQLite integrity checks, root-only archive/quarantine, a separate retention timer, and
restore rehearsal.

## Data flow

Production creates `TIMESTAMP-RANDOM.bundle` and sends it with rsync. The key is forced to:

```text
/usr/bin/rrsync -wo -no-del -no-overwrite -munge /var/spool/mafusheets-backup/incoming
```

`rrsync` rejects reads and arbitrary commands, prevents deletion and replacement, confines paths,
and munges links. Rsync writes hidden temporary files and renames a completed upload atomically.
Every 15 minutes a root service detaches visible bundles, safely extracts regular files, verifies
the manifest checksums and SQLite integrity, and creates a root-owned read-only archive directory.
Failures are moved to root-only quarantine. The upload account cannot traverse archive,
quarantine, or work.

## HomeServer install

Do not move or delete existing data. Install dependencies and tools:

```sh
sudo apt-get install --no-install-recommends openssh-server rsync python3 sqlite3
sudo ops/offsite-backup/install-home-server-tools.sh
sudo ops/offsite-backup/install-backup-ssh-hardening.sh /root/production-backup.pub
sudo sshd -t
```

The SSH installer snapshots its two changed files and prints an exact rollback command. It does
not reload SSH. Keep an administrator session open, inspect
`/etc/ssh/authorized_keys/mafusheets-backup`, then reload only after `sshd -t` succeeds:

```sh
sudo systemctl reload ssh
```

Run `npm run test:offsite-backup`, then the installed boundary checks. Enable only the receiver:

```sh
sudo systemctl start mafusheets-backup-receiver.service
sudo systemctl enable --now mafusheets-backup-receiver.timer
systemctl is-enabled mafusheets-backup-retention.timer  # expected: disabled
```

Migration from `/srv/backups/mafusheets/incoming`: leave it root-owned and unchanged. New uploads
go to `/var/spool/mafusheets-backup/incoming`. Inventory and manually verify old objects; never
copy them directly into archive.

## Production install

Install `rsync`, OpenSSH client, Tailscale, Python, tar, OpenSSL, and coreutils. Configure
`/etc/mafusheets/offsite-backup.env` from the example with mode `0600`, pin the HomeServer host key,
and use its tagged MagicDNS name. Manually start the sender service once and inspect both journals
before enabling its timer.

## Tailscale

Apply manually; do not use the current `100.93.39.106` address in policy:

```json
{
  "tagOwners": {
    "tag:mafusheets-prod": ["autogroup:admin"],
    "tag:backup-server": ["autogroup:admin"]
  },
  "grants": [{
    "src": ["tag:mafusheets-prod"],
    "dst": ["tag:backup-server"],
    "ip": ["tcp:22"]
  }]
}
```

Validate with `tailscale status`, `tailscale ping BACKUP_SERVER_MAGICDNS`, `sshd -t`, and
`test-production-boundary.sh`.

## Retention

Retention is installed but disabled. After a restore rehearsal, set a positive day count in a
root-owned mode-`0600` `/etc/mafusheets/backup-retention.env`, manually run the service, inspect
what remains, and only then enable its timer. Roll back with:

```sh
sudo systemctl disable --now mafusheets-backup-retention.timer
```

This design protects archive history from a compromised production VPS. It does not protect
against HomeServer root compromise, physical loss, silent disk failure, or loss of separately
managed secrets; use filesystem snapshots and another copy if those risks matter.
