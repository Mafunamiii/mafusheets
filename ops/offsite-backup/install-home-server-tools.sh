#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
LIBEXEC=/usr/local/libexec
SYSTEMD=/etc/systemd/system
DOCDIR=/usr/local/share/doc/mafusheets-backup

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 77; }
for dependency in python3 rsync rrsync tar sha256sum sqlite3 flock; do
    command -v "$dependency" >/dev/null 2>&1 || {
        echo "$dependency is required (install rsync, sqlite3, python3, and coreutils)" >&2
        exit 69
    }
done
python3 -c 'import hashlib, json, sqlite3, tarfile' || {
    echo "required Python standard-library modules are unavailable" >&2
    exit 69
}

install -d -o root -g root -m 0755 "$LIBEXEC" "$DOCDIR"
install -o root -g root -m 0644 \
    "$SOURCE_DIR/scripts/mafusheets_backup.py" "$LIBEXEC/mafusheets_backup.py"
install -o root -g root -m 0755 \
    "$SOURCE_DIR/scripts/offsite-backup-receive.py" "$LIBEXEC/mafusheets-backup-receive"
install -o root -g root -m 0755 \
    "$SOURCE_DIR/scripts/mafusheets-backup-restore" "$LIBEXEC/mafusheets-backup-restore"
install -o root -g root -m 0755 \
    "$SOURCE_DIR/scripts/offsite-backup-retention.sh" "$LIBEXEC/mafusheets-backup-retention"
for doc in README.md BACKUP_FORMAT.md RECOVERY_RUNBOOK.md; do
    install -o root -g root -m 0644 \
        "$SOURCE_DIR/ops/offsite-backup/$doc" "$DOCDIR/$doc"
done
for unit in mafusheets-backup-receiver.service mafusheets-backup-receiver.timer \
    mafusheets-backup-retention.service mafusheets-backup-retention.timer; do
    install -o root -g root -m 0644 "$SOURCE_DIR/ops/offsite-backup/$unit" "$SYSTEMD/$unit"
done
install -o root -g root -m 0644 \
    "$SOURCE_DIR/ops/offsite-backup/mafusheets-backup-tmpfiles.conf" \
    /etc/tmpfiles.d/mafusheets-backup.conf

systemd-tmpfiles --create /etc/tmpfiles.d/mafusheets-backup.conf
systemctl daemon-reload
systemd-analyze verify "$SYSTEMD/mafusheets-backup-receiver.service" \
    "$SYSTEMD/mafusheets-backup-retention.service"

echo "HomeServer tools installed. Retention timer was not enabled."
echo "Next: install SSH hardening, run tests, then enable only the receiver timer."
