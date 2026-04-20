#!/usr/bin/env bash
# Compile every examples/demo-*.md and fail if any compile errors.
# Used by the compile-demos CI workflow and convenient for local
# regression testing:
#
#   scripts/compile-all-demos.sh
#
# Exits non-zero if any demo fails. Prints a summary at the end.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

declare -a PASSED=()
declare -a FAILED=()

for demo in "$REPO_ROOT"/examples/demo-*.md; do
  name="$(basename "$demo")"
  echo ""
  echo "━━━ $name ━━━"
  if "$SCRIPT_DIR/compile-demo.sh" "$demo"; then
    PASSED+=("$name")
  else
    FAILED+=("$name")
  fi
done

echo ""
echo "━━━ Summary ━━━"
echo "passed: ${#PASSED[@]}"
for n in "${PASSED[@]}"; do echo "  OK   $n"; done
echo "failed: ${#FAILED[@]}"
for n in "${FAILED[@]}"; do echo "  FAIL $n"; done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  exit 1
fi
