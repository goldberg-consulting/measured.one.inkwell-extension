#!/usr/bin/env bash
# Run the actual extension compiler and runner in a disposable project.
# Supports check-demos.cjs flags, including --report=/path/report.json.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
npm --prefix "$REPO_ROOT" run compile
exec node "$SCRIPT_DIR/check-demos.cjs" "$@"
