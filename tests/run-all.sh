#!/usr/bin/env bash
# tests/run-all.sh — run the full token-guard test suite:
#   - node --test plugin/test   (guard.js unit tests)
#   - python3 -m unittest discover tests/  (oc-wait, oc-wait-pipeline, oc-inbox, token-audit)
# Prints a clear pass/fail summary and exits non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OVERALL_FAIL=0

echo "=== node --test plugin/test ==="
if node --test "plugin/test/"*.test.js; then
  NODE_RESULT="PASS"
else
  NODE_RESULT="FAIL"
  OVERALL_FAIL=1
fi

echo ""
echo "=== python3 -m unittest discover tests/ ==="
if python3 -m unittest discover -s tests -p 'test_*.py' -v; then
  PY_RESULT="PASS"
else
  PY_RESULT="FAIL"
  OVERALL_FAIL=1
fi

echo ""
echo "========== SUMMARY =========="
printf '%-30s %s\n' "node --test (plugin/test)" "$NODE_RESULT"
printf '%-30s %s\n' "python3 unittest (tests/)" "$PY_RESULT"
echo "=============================="

if [ "$OVERALL_FAIL" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
exit 0
