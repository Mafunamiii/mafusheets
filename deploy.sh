#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="${LOCAL_DIR:-$SCRIPT_DIR/}"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    line="${raw_line#"${raw_line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"

    if [[ -z "${line}" || "${line}" == \#* || "${line}" != *"="* ]]; then
      continue
    fi

    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:-1}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:-1}"
    fi

    if [[ -n "${key}" && -z "${!key:-}" ]]; then
      export "${key}=${value}"
    fi
  done < "${ENV_FILE}"
fi

REMOTE_HOST="${REMOTE_HOST:?Set REMOTE_HOST in .env or the environment.}"
REMOTE_DIR="${REMOTE_DIR:?Set REMOTE_DIR in .env or the environment.}"
APP_NAME="${APP_NAME:?Set APP_NAME in .env or the environment.}"
INSTALL_DEPS=1

case "${1:-}" in
  --skip-install)
    INSTALL_DEPS=0
    ;;
  --pull)
    echo "Pulling app files from ${REMOTE_HOST}:${REMOTE_DIR}"
    rsync -avh --progress       --exclude node_modules       --exclude uploads       --exclude data       --exclude .tmp       --exclude .env       "${REMOTE_HOST}:${REMOTE_DIR}"       "${LOCAL_DIR}"
    exit 0
    ;;
esac

echo "Syncing app files to ${REMOTE_HOST}:${REMOTE_DIR}"
rsync -avh --progress   --exclude node_modules   --exclude uploads   --exclude data   --exclude .tmp   --exclude .env   "${LOCAL_DIR}"   "${REMOTE_HOST}:${REMOTE_DIR}"

if [[ "${INSTALL_DEPS}" == "1" ]]; then
  echo "Installing production dependencies and restarting ${APP_NAME}"
  ssh "${REMOTE_HOST}" "cd ${REMOTE_DIR} && npm install --omit=dev && pm2 restart ${APP_NAME}"
else
  echo "Restarting ${APP_NAME} without npm install"
  ssh "${REMOTE_HOST}" "cd ${REMOTE_DIR} && pm2 restart ${APP_NAME}"
fi

echo "Deployment complete."
