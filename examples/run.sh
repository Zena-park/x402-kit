#!/usr/bin/env bash
# Run the runnable examples against a local world (e2e/harness.sh boots anvil +
# the canonical permit2 contracts + an in-repo TestToken + the facilitator).
# Nothing leaves your machine. Pass a name to run just one:
#   examples/run.sh seller-paid-api | metered-api | pos-terminal | subscription | paid-mcp-tool
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../e2e" && pwd)/harness.sh"

PICK="${1:-all}"
for name in seller-paid-api metered-api pos-terminal subscription paid-mcp-tool; do
  if [ "$PICK" = "all" ] || [ "$PICK" = "$name" ]; then
    echo
    echo "── $name ─────────────────────────────────────────────"
    TOKEN_ADDRESS="$TOKEN" npx tsx "$ROOT/examples/$name.ts"
  fi
done
