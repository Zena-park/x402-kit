#!/usr/bin/env bash
# e2e — boot the shared local world (e2e/harness.sh: anvil + canonical permit2
# contracts + in-repo TestToken + facilitator), then run every scenario:
# pay (S1) · flow (presets) · permit2 (S4) · upto (S6) · schedule (pre-signed recurring).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"

echo
TOKEN_ADDRESS="$TOKEN" npx tsx "$ROOT/e2e/pay.ts"
echo
TOKEN_ADDRESS="$TOKEN" npx tsx "$ROOT/e2e/flow.ts"
echo
TOKEN_ADDRESS="$TOKEN" npx tsx "$ROOT/e2e/permit2.ts"
echo
TOKEN_ADDRESS="$TOKEN" npx tsx "$ROOT/e2e/upto.ts"
echo
TOKEN_ADDRESS="$TOKEN" npx tsx "$ROOT/e2e/schedule.ts"
