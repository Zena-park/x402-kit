# Shared local-world bootstrap — SOURCE this, don't run it.
# Starts anvil, injects the canonical Permit2 + x402ExactPermit2Proxy +
# x402UptoPermit2Proxy bytecode (vendored from Base — e2e/bytecode/README.md), deploys the in-repo TestToken
# (minimal EIP-3009 ERC-20), mints to the buyer, and starts @x402kit/facilitator.
# Exposes: $ROOT · $RPC · $TOKEN · $DEPLOYER_KEY · $BUYER. Leaves the caller's
# cwd at $ROOT (npx resolution). Cleans up on EXIT.
#
# Address source of truth: PERMIT2_ADDRESS / X402_PERMIT2_PROXY_ADDRESS in
# packages/core/src/exact/permit2Eip712.ts and X402_UPTO_PERMIT2_PROXY_ADDRESS in
# packages/core/src/upto/eip712.ts (e2e/permit2.ts and e2e/upto.ts assert against them).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC=http://127.0.0.1:8545

ANVIL_PID=""
FACIL_PID=""
CONFIG="$ROOT/e2e/.facilitator.e2e.json"
FACIL_LOG="$(mktemp -t x402kit-facilitator.XXXXXX.log)"
cleanup() {
  [ -n "$FACIL_PID" ] && kill "$FACIL_PID" 2>/dev/null || true
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -f "$CONFIG"
}
trap cleanup EXIT

# anvil default accounts
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # #0 - issuer and facilitator
BUYER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                                # #1 - buyer (signs only)

echo "> starting anvil"
anvil --silent --port 8545 &
ANVIL_PID=$!
until cast block-number --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.2; done

echo "> injecting Permit2 + x402ExactPermit2Proxy + x402UptoPermit2Proxy (canonical addresses, vendored bytecode)"
cast rpc anvil_setCode 0x000000000022D473030F116dDEE9F6B43aC78BA3 \
  "$(cat "$ROOT/e2e/bytecode/permit2.hex")" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setCode 0x402085c248EeA27D92E8b30b2C58ed07f9E20001 \
  "$(cat "$ROOT/e2e/bytecode/x402-permit2-proxy.hex")" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setCode 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002 \
  "$(cat "$ROOT/e2e/bytecode/x402-upto-permit2-proxy.hex")" --rpc-url "$RPC" >/dev/null

echo "> deploying TestToken (in-repo minimal EIP-3009 ERC-20 — e2e/contracts)"
TOKEN=$(forge create --root "$ROOT/e2e/contracts" src/TestToken.sol:TestToken \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast --json \
  --constructor-args "Test KRW Stablecoin" "TKRW" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["deployedTo"])')
echo "  $TOKEN"

echo "> minting 100,000 KRW to the buyer"
cast send "$TOKEN" "mint(address,uint256)" "$BUYER" 100000000000 \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null

echo "> starting facilitator (@x402kit/facilitator)"
cat > "$CONFIG" <<EOF
{
  "port": 4021,
  "unauthenticatedSettle": true,
  "chains": [
    {
      "network": "eip155:31337",
      "rpcUrl": "$RPC",
      "tokens": [{ "address": "$TOKEN", "name": "Test KRW Stablecoin", "version": "1" }]
    }
  ]
}
EOF
cd "$ROOT"
FACILITATOR_CONFIG="$CONFIG" PRIVATE_KEY="$DEPLOYER_KEY" \
  npx tsx packages/facilitator/src/server.ts > "$FACIL_LOG" 2>&1 &
FACIL_PID=$!
until curl -sf http://127.0.0.1:4021/health >/dev/null 2>&1; do sleep 0.3; done
