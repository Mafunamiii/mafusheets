#!/usr/bin/env bash
set -euo pipefail

umask 077

ARCHIVE="${MAFUSHEETS_ARCHIVE_DIR:-/srv/backups/mafusheets/archive}"
RUN_DIR="${MAFUSHEETS_RUN_DIR:-/run/mafusheets-backup}"
RETENTION_DAYS="${MAFUSHEETS_RETENTION_DAYS:-0}"

if [[ ! "${RETENTION_DAYS}" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 1 )); then
  echo "Retention is disabled: set MAFUSHEETS_RETENTION_DAYS to a positive integer." >&2
  exit 1
fi

mkdir -p "${RUN_DIR}"
exec 9>"${RUN_DIR}/retention.lock"
flock -n 9 || exit 0
find "${ARCHIVE}" -regextype posix-extended \
  -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" \
  -regex '.*/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{24}' -exec rm -rf -- {} +
printf '%s retention applied %s-day policy\n' \
  "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "${RETENTION_DAYS}"
