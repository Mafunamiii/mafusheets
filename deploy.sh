#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="${LOCAL_DIR:-${SCRIPT_DIR}/}"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  mode="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${ENV_FILE}")"
  if [[ "${mode}" != "600" ]]; then
    echo "Refusing to use ${ENV_FILE}: set its permissions to 0600." >&2
    exit 1
  fi
  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    line="${raw_line#"${raw_line%%[![:space:]]*}"}"
    [[ -z "${line}" || "${line}" == \#* || "${line}" != *"="* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${value}" == \"*\" && "${value}" == *\" ]] ||
       [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:-1}"
    fi
    if [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && -z "${!key:-}" ]]; then
      export "${key}=${value}"
    fi
  done < "${ENV_FILE}"
fi

REMOTE_HOST="${REMOTE_HOST:?Set REMOTE_HOST in the protected environment file.}"
REMOTE_DIR="${REMOTE_DIR:?Set REMOTE_DIR in the protected environment file.}"
RSYNC_EXCLUDES=(
  --exclude .git --exclude .agents --exclude .codex --exclude .idea
  --exclude node_modules --exclude uploads --exclude data --exclude .tmp
  --exclude .env --exclude '*.sqlite*' --exclude '*backup*' --exclude 'audit*.json'
)

case "${1:-}" in
  --pull)
    if [[ "${REMOTE_HOST}" == "local" ]]; then
      echo "REMOTE_HOST=local: source and deployment directory are already the same."
    else
      rsync -avh --progress \
        "${RSYNC_EXCLUDES[@]}" \
        "${REMOTE_HOST}:${REMOTE_DIR}/" "${LOCAL_DIR}"
    fi
    ;;
  --apply)
    if [[ "${REMOTE_HOST}" == "local" ]]; then
      cd "${REMOTE_DIR}"
      test "$(stat -c '%a' .env)" = 600
      docker compose config --quiet
      docker compose up -d --build --remove-orphans
    else
      rsync -avh --progress \
        "${RSYNC_EXCLUDES[@]}" \
        "${LOCAL_DIR}" "${REMOTE_HOST}:${REMOTE_DIR}/"
      ssh "${REMOTE_HOST}" \
        "cd '${REMOTE_DIR}' && test \"\$(stat -c '%a' .env)\" = 600 && docker compose config --quiet && docker compose up -d --build --remove-orphans"
    fi
    ;;
  --verify|"")
    exec "${SCRIPT_DIR}/scripts/verify-production.sh"
    ;;
  *)
    echo "Usage: ./deploy.sh [--verify|--apply|--pull]" >&2
    exit 2
    ;;
esac
