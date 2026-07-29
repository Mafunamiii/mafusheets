#!/usr/bin/env bash
set -euo pipefail

umask 077

ENV_FILE="${MAFUSHEETS_BACKUP_ENV:-/etc/mafusheets/offsite-backup.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing protected backup environment: ${ENV_FILE}" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "${ENV_FILE}")" != "600" ]]; then
  echo "Refusing ${ENV_FILE}: permissions must be 0600." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "${ENV_FILE}"

: "${MAFUSHEETS_PROJECT_DIR:?Set MAFUSHEETS_PROJECT_DIR}"
: "${BACKUP_REMOTE_HOST:?Set BACKUP_REMOTE_HOST to the Tailscale hostname}"
: "${BACKUP_SSH_KEY:?Set BACKUP_SSH_KEY}"
: "${BACKUP_LOCAL_STAGING:?Set BACKUP_LOCAL_STAGING}"
: "${BACKUP_APPLICATION_COMMIT:?Set BACKUP_APPLICATION_COMMIT to the deployed commit}"
: "${BACKUP_IMAGE_DIGEST:?Set BACKUP_IMAGE_DIGEST to an immutable sha256 digest}"
: "${BACKUP_CONFIG_ID:?Set BACKUP_CONFIG_ID}"

BACKUP_REMOTE_USER="${BACKUP_REMOTE_USER:-mafusheets-backup}"
BACKUP_SSH_PORT="${BACKUP_SSH_PORT:-22}"
BACKUP_MAX_BUNDLE_BYTES="${BACKUP_MAX_BUNDLE_BYTES:-21474836480}"

for value in "${BACKUP_REMOTE_USER}" "${BACKUP_REMOTE_HOST}"; do
  if [[ ! "${value}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Unsafe remote identity value." >&2
    exit 1
  fi
done
if [[ ! "${BACKUP_SSH_PORT}" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_SSH_PORT must be numeric." >&2
  exit 1
fi
if [[ ! "${BACKUP_MAX_BUNDLE_BYTES}" =~ ^[0-9]+$ ]] || (( BACKUP_MAX_BUNDLE_BYTES < 1 )); then
  echo "BACKUP_MAX_BUNDLE_BYTES must be a positive integer." >&2
  exit 1
fi
if [[ ! "${BACKUP_APPLICATION_COMMIT}" =~ ^[a-fA-F0-9]{7,64}$ ]]; then
  echo "BACKUP_APPLICATION_COMMIT must be a Git commit hash." >&2
  exit 1
fi
if [[ ! "${BACKUP_IMAGE_DIGEST}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "BACKUP_IMAGE_DIGEST must be an immutable sha256:<64 lowercase hex> digest." >&2
  exit 1
fi

mkdir -p "${BACKUP_LOCAL_STAGING}"
chmod 700 "${BACKUP_LOCAL_STAGING}"
exec 9>"${BACKUP_LOCAL_STAGING}/.offsite-backup.lock"
if ! flock -n 9; then
  echo "Another off-site backup is already running." >&2
  exit 1
fi

backup_id="$(date -u +'%Y%m%dT%H%M%SZ')-$(openssl rand -hex 12)"
bundle_directory="${BACKUP_LOCAL_STAGING}/${backup_id}"
bundle_name="${backup_id}.bundle"
bundle_file="${BACKUP_LOCAL_STAGING}/${bundle_name}"
remote="${BACKUP_REMOTE_USER}@${BACKUP_REMOTE_HOST}"

app_stopped=0
restart_app() {
  if [[ "${app_stopped}" == "1" ]]; then
    docker compose --project-directory "${MAFUSHEETS_PROJECT_DIR}" start mafusheets >/dev/null
    app_stopped=0
  fi
}
trap restart_app EXIT INT TERM

docker compose --project-directory "${MAFUSHEETS_PROJECT_DIR}" stop mafusheets
app_stopped=1
docker compose --project-directory "${MAFUSHEETS_PROJECT_DIR}" run --rm --no-deps \
  --volume "${BACKUP_LOCAL_STAGING}:/offsite-backup" \
  mafusheets \
  node scripts/release-data.js backup --quiesced \
    --database /var/lib/mafusheets/database/mafusheets.sqlite \
    --uploads /var/lib/mafusheets/uploads \
    --output "/offsite-backup/${backup_id}" \
    --application-commit "${BACKUP_APPLICATION_COMMIT}" \
    --image-digest "${BACKUP_IMAGE_DIGEST}" \
    --bundle-id "${backup_id}" \
    --config-id "${BACKUP_CONFIG_ID}"
restart_app

tar --create --file "${bundle_file}" --directory "${bundle_directory}" .
chmod 600 "${bundle_file}"
bundle_size="$(stat -c '%s' "${bundle_file}")"
if (( bundle_size > BACKUP_MAX_BUNDLE_BYTES )); then
  echo "Backup bundle exceeds BACKUP_MAX_BUNDLE_BYTES." >&2
  exit 1
fi
# The server forces packaged rrsync in write-only/no-delete/no-overwrite mode.
# rsync's temporary file is atomically renamed only after a complete transfer.
rsync --archive --delay-updates --ignore-existing \
  -e "ssh -i ${BACKUP_SSH_KEY} -p ${BACKUP_SSH_PORT} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" \
  "${bundle_file}" "${remote}:${bundle_name}"

find "${bundle_directory}" -depth -delete
rm -f -- "${bundle_file}"
echo "Off-site backup delivered: ${remote}:${bundle_name}"
