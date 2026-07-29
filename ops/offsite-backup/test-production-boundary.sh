#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_REMOTE_HOST:?set the tagged HomeServer MagicDNS name}"
: "${BACKUP_SSH_KEY:?set the production backup private key path}"
BACKUP_REMOTE_USER="${BACKUP_REMOTE_USER:-mafusheets-backup}"
BACKUP_SSH_PORT="${BACKUP_SSH_PORT:-22}"
remote="${BACKUP_REMOTE_USER}@${BACKUP_REMOTE_HOST}"
ssh_options=(-i "${BACKUP_SSH_KEY}" -p "${BACKUP_SSH_PORT}" -o BatchMode=yes
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes)

negative() {
  local label="$1"
  shift
  set +e
  output="$(ssh "${ssh_options[@]}" "${remote}" "$@" 2>&1)"
  status=$?
  set -e
  if (( status == 0 )) || [[ "${output}" == *"uid="* ]]; then
    echo "FAIL ${label}: command was not rejected: ${output}" >&2
    exit 1
  fi
  echo "PASS ${label}"
}

negative arbitrary-command id
negative archive-access "find /srv/backups/mafusheets/archive"
negative deletion "rm -f /var/spool/mafusheets-backup/incoming/test.bundle"
negative rename "mv a.bundle b.bundle"
negative listing "find /var/spool/mafusheets-backup/incoming"

echo "Forced rrsync rejected arbitrary command, archive access, deletion, rename, and listing."
