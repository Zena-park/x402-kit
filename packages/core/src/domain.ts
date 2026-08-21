/**
 * EIP-712 domain resolution shared by EVM schemes. Operator-known metadata
 * (ctx.assetInfo) is trusted over the wire's `extra` — the allowlist then
 * vouches not just for *which* asset but for *what domain* it signs under.
 */

import type { PaymentRequirements } from "./types.js";
import type { ChainContext } from "./scheme.js";
import type { Eip712DomainParams } from "./exact/eip712.js";

export function resolveDomain(
  req: PaymentRequirements,
  ctx: Pick<ChainContext, "chainId" | "assetInfo">,
): Eip712DomainParams | undefined {
  const known = ctx.assetInfo?.(req.asset);
  const name = known?.name ?? req.extra?.name;
  const version = known?.version ?? req.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") return undefined;
  return { name, version, chainId: ctx.chainId, verifyingContract: req.asset };
}
