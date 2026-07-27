#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

public_origin="${PUBLIC_ORIGIN:?Set PUBLIC_ORIGIN to the deployed HTTPS origin.}"
app_id="$(docker compose ps -q mafusheets)"
proxy_id="$(docker compose ps -q nginx)"
[[ -n "${app_id}" && -n "${proxy_id}" ]] || {
  echo "The mafusheets and nginx services must be running." >&2
  exit 1
}

app_user="$(docker inspect --format '{{.Config.User}}' "${app_id}")"
[[ "${app_user}" == "1000:1000" ]] || {
  echo "Unexpected application runtime user: ${app_user}" >&2
  exit 1
}

[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "${app_id}")" == "true" ]]
[[ "$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${app_id}")" == '{"3000/tcp":null}' ]]

docker compose exec -T mafusheets sh -c '
  test "$(id -u)" = 1000
  test ! -w /app/server.js
  test ! -w /app/node_modules
  wget -q -O /dev/null http://127.0.0.1:3000/ready
'

http_port="${HTTP_PORT:-80}"
bind_ip="${HTTPS_BIND_IP:-127.0.0.1}"
if [[ "${bind_ip}" == "0.0.0.0" ]]; then bind_ip="127.0.0.1"; fi
redirect_headers="$(curl -sS -D - -o /dev/null "http://${bind_ip}:${http_port}/verification")"
grep -q '^HTTP/.* 308' <<<"${redirect_headers}"
grep -qi "^location: ${public_origin}/verification" <<<"${redirect_headers}"

for sensitive_path in /.env /data/mafusheets.sqlite /backup.sqlite /app.js.map /ready; do
  status="$(curl -k -sS -o /dev/null -w '%{http_code}' "${public_origin}${sensitive_path}")"
  [[ "${status}" == "404" ]] || {
    echo "Sensitive path was not blocked: ${sensitive_path} (${status})" >&2
    exit 1
  }
done

oversize_status="$(
  curl -k -sS -o /dev/null -w '%{http_code}' \
    -X POST -H 'Content-Length: 157286401' "${public_origin}/api/upload"
)"
[[ "${oversize_status}" == "413" ]]

echo "Running production stack passed non-root, read-only, private-port, redirect,"
echo "sensitive-path, request-size, and readiness checks."
