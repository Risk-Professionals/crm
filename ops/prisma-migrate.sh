#!/usr/bin/env bash
set -euo pipefail
cd /workspace
exec bun run db:deploy "$@"
