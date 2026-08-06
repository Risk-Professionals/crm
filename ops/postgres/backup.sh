#!/usr/bin/env bash
set -euo pipefail
exec /usr/local/bin/crm-postgres backup "$@"
