#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ -z "${API_INTERNAL_URL:-}" ]]; then
  printf '%s\n' 'API_INTERNAL_URL is required' >&2
  exit 1
fi

if [[ -z "${CRON_SECRET:-}" ]]; then
  printf '%s\n' 'CRON_SECRET is required' >&2
  exit 1
fi

printf 'header = "Authorization: Bearer %s"\n' "$CRON_SECRET" |
  curl --config - --fail --silent --show-error --output /dev/null --request POST \
    "${API_INTERNAL_URL%/}/internal/sync"
