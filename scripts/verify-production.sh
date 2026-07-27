#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

required=(PUBLIC_ORIGIN SESSION_SECRET TLS_CERT_PATH TLS_KEY_PATH)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required production setting: ${name}" >&2
    exit 1
  fi
done

[[ "${PUBLIC_ORIGIN}" == https://* ]] || {
  echo "PUBLIC_ORIGIN must use https://." >&2
  exit 1
}
[[ "${#SESSION_SECRET}" -ge 32 ]] || {
  echo "SESSION_SECRET must contain at least 32 characters." >&2
  exit 1
}
[[ -r "${TLS_CERT_PATH}" && -r "${TLS_KEY_PATH}" ]] || {
  echo "TLS certificate and key must exist and be readable." >&2
  exit 1
}

docker compose config --quiet
docker build --check .
docker build --check nginx

echo "Production configuration passed static verification."
echo "Run './deploy.sh --apply' only when you intend to update the configured remote host."
