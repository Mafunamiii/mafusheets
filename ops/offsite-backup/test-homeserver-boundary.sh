#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == 0 ]] || {
  echo "run as root" >&2
  exit 77
}

test "$(stat -c '%U:%G:%a' /var/spool/mafusheets-backup/incoming)" \
  = "mafusheets-backup:mafusheets-backup:700"
test "$(stat -c '%U:%G:%a' /srv/backups/mafusheets/archive)" = "root:root:700"
test "$(stat -c '%U:%G' /srv/backups/mafusheets/archive)" = "root:root"
if sudo -u mafusheets-backup test -r /srv/backups/mafusheets/archive; then
  echo "FAIL upload account can read archive" >&2
  exit 1
fi
if sudo -u mafusheets-backup test -w /srv/backups/mafusheets/archive; then
  echo "FAIL upload account can write archive" >&2
  exit 1
fi
systemctl is-enabled mafusheets-backup-retention.timer >/dev/null 2>&1 && {
  echo "FAIL retention timer is enabled" >&2
  exit 1
}
sshd -t
echo "HomeServer ownership, archive isolation, retention-disabled, and sshd tests passed."
