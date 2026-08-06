#!/usr/bin/env bash
set -euo pipefail
cd /workspace
exec bun workflow-bootstrap/dist/cli.js "$@"
