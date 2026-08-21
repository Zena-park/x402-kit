/**
 * Facilitator core — pure logic, separated from transport (HTTP).
 *
 * createFacilitator() is a library: embed it in your own server, or let
 * server.ts wrap it with node:http as a turnkey binary.
 *
 * Stateless by default — the truth about nonce consumption lives on-chain, so
 * this runs with no database. The only state is the settle idempotency cache
 * (in-memory, TTL) that suppresses duplicate submission of the same payment
 * within a short window. Past that window the real guard is the on-chain nonce.
 *
 * That cache is per PROCESS. Run ONE instance per signer key: two replicas
 * sharing a key each believe they hold the only in-flight copy of a payment,
 * both broadcast, and the loser burns a reverted tx. Scale by giving each
 * replica its own key (and its own gas balance), not by sharing one.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  nonceManager,
  toHex,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ErrorReason,
  ErrorReasonExtra,
  caip2ChainId,
  canonicalAddress,
  exactScheme,
  matchesNetwork,
  parseAmount,
  parseFacilitatorRequest,
  resolveHandler,
  sameAddress,
  uptoScheme,
  validateChainContext,
  type AnySchemeHandler,
  type ChainContext,
  type FacilitatorRequest,
  type Network,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@x402kit/core";
import { chainIdOf, ConfigError, type ChainConfig, type ResolvedConfig } from "./config.js";

/** Cap on the in-memory settle cache — a runaway backstop, far above real load */
const MAX_SETTLING_ENTRIES = 10_000;

/** Node's setTimeout clamps any delay above this to 1ms — never exceed it */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The longest validity window that influences cache retention. The wire's
 * maxTimeoutSeconds is caller-controlled; without a clamp one request could
 * pin a cache entry (and a "pending" verdict) for weeks.
 */
const MAX_RETENTION_BASIS_SECONDS = 3600;

const DEFAULT_MAX_INFLIGHT_SETTLES = 16;

/** Minimum spacing between full backstop sweeps of the settle cache */
const SWEEP_INTERVAL_MS = 1000;

/**
 * How long a settled/pending cache entry is retained. 2× the validity window
 * (min 5 minutes, basis capped at 1 hour), CLAMPED to setTimeout's ceiling.
 */
function retentionTtlMs(maxTimeoutSeconds: number): number {
  const basis = Math.min(maxTimeoutSeconds, MAX_RETENTION_BASIS_SECONDS);
  return Math.min(Math.max(basis * 2, 300) * 1000, MAX_TIMEOUT_MS);
}

/**
 * Shape-validate an untrusted facilitator request (zod) before any handler
 * touches it — the edge that keeps a crafted body from throwing deep inside a
 * handler (which would poison the cache and leak 500s). Returns a reason code
 * on rejection.
 */
function validateRequest(req: unknown): string | undefined {
  const parsed = parseFacilitatorRequest(req);
  if (parsed.ok) return undefined;
  // Map to the coarse protocol code; the detailed zod path stays in logs only.
  if (parsed.error.startsWith("x402Version")) return ErrorReason.INVALID_X402_VERSION;
  if (parsed.error.startsWith("paymentRequirements")) return ErrorReason.INVALID_PAYMENT_REQUIREMENTS;
  return ErrorReason.INVALID_PAYLOAD;
}

interface ChainRuntime {
  ctx: ChainContext;
  tokens: ChainConfig["tokens"];
  /** Settlements currently past the cache and inside handler.settle */
  inflight: number;
}

export interface Facilitator {
  verify(req: FacilitatorRequest): Promise<VerifyResponse>;
  settle(req: FacilitatorRequest): Promise<SettleResponse>;
  supported(): SupportedResponse;
  /**
   * Liveness. `gas` is coarse on purpose ("ok" | "empty" | "unreachable") —
   * exact balances would let an attacker size a gas-drain precisely.
   */
  health(): Promise<{ ok: boolean; gas: Record<string, "ok" | "empty" | "unreachable"> }>;
  /**
   * Ask every configured RPC for its chain id and fail if it disagrees with
   * the configured CAIP-2 network. Call once at startup: a mis-paired RPC
   * makes every signature verify against the wrong EIP-712 domain, or
   * settle on the wrong chain. Throws ConfigError on the first mismatch.
   */
  assertChainIds(): Promise<void>;
  signerAddress: Address;
}

/** Build clients from a bare chainId, without viem/chains — any EVM connects */
function minimalChain(id: number, rpcUrl: string): Chain {
  return {
    id,
    name: `eip155:${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export function createFacilitator(
  config: ResolvedConfig,
  extraSchemes: AnySchemeHandler[] = [],
): Facilitator {
  // nonceManager: concurrent settles on one chain get consecutive nonces from
  // a local counter instead of each reading the same "pending" count from the
  // RPC and colliding (one replaced → reported via the other's receipt, or
  // rejected as "nonce too low" for a perfectly valid payment).
  const account = privateKeyToAccount(config.signerKey, { nonceManager });
  // The key has served its purpose — do not keep it reachable from the config
  // object this closure holds for the life of the process.
  (config as { signerKey: string }).signerKey = "0x<redacted>";
  const handlers: AnySchemeHandler[] = [exactScheme, uptoScheme, ...extraSchemes];
  const maxInflight = config.maxInflightSettles ?? DEFAULT_MAX_INFLIGHT_SETTLES;

  const chains = new Map<Network, ChainRuntime>(
    config.chains.map((chainConfig) => {
      const chain = minimalChain(chainIdOf(chainConfig.network), chainConfig.rpcUrl);
      // batch: independent reads (block time, nonce, balance) coalesce into one HTTP round trip
      const transport = http(chainConfig.rpcUrl, { batch: true });
      const ctx: ChainContext = {
        network: chainConfig.network,
        chainId: chain.id,
        publicClient: createPublicClient({ chain, transport }),
        walletClient: createWalletClient({ chain, transport, account }),
        ...(chainConfig.erc6492Settler ? { erc6492Settler: chainConfig.erc6492Settler } : {}),
        ...(chainConfig.permit2Address ? { permit2Address: chainConfig.permit2Address } : {}),
        ...(chainConfig.permit2Proxy ? { permit2Proxy: chainConfig.permit2Proxy } : {}),
        ...(chainConfig.uptoPermit2Proxy ? { uptoPermit2Proxy: chainConfig.uptoPermit2Proxy } : {}),
        ...(chainConfig.maxSettleGas ? { maxSettleGas: chainConfig.maxSettleGas } : {}),
        ...(chainConfig.maxErc6492SettleGas ? { maxErc6492SettleGas: chainConfig.maxErc6492SettleGas } : {}),
        assetInfo: (asset) =>
          chainConfig.tokens === "*"
            ? undefined
            : chainConfig.tokens.find((t) => sameAddress(t.address, asset)),
      };
      validateChainContext(ctx);
      return [chainConfig.network, { ctx, tokens: chainConfig.tokens, inflight: 0 }];
    }),
  );

  /**
   * Operator policy on the terms — the allowlist (which token), the floor
   * (how little is worth our gas), and the recipient scope (whose sellers).
   * Returns a reason code, or undefined when the terms are acceptable.
   */
  function termsPolicy(
    chain: ChainRuntime,
    reqs: FacilitatorRequest["paymentRequirements"],
  ): string | undefined {
    if (chain.tokens !== "*") {
      const token = chain.tokens.find((t) => sameAddress(t.address, reqs.asset));
      if (!token) return ErrorReason.INVALID_PAYMENT_REQUIREMENTS;
      const value = parseAmount(reqs.amount);
      if (value === undefined) return ErrorReason.INVALID_PAYMENT_REQUIREMENTS;
      // The floor guards the operator's gas against dust, at verify AND at
      // settle — for upto the cap is judged first and the seller's settle-time
      // actual again, so a cap above the floor cannot become a 1-wei broadcast
      // on our gas. Zero is exempt: it never broadcasts (upto settles $0
      // off-chain; every scheme refuses zero-valued terms at verify).
      const floor = parseAmount(token.minAmount ?? "1") ?? 1n;
      if (value !== 0n && value < floor) return ErrorReason.INVALID_PAYMENT_REQUIREMENTS;
    }
    if (config.allowedPayTo && !config.allowedPayTo.some((a) => sameAddress(a, reqs.payTo))) {
      return ErrorReason.INVALID_PAYMENT_REQUIREMENTS;
    }
    return undefined;
  }

  /**
   * Route the request to a scheme and chain. Scheme/network capability is
   * core's rule (resolveHandler); only what is genuinely the operator's —
   * which chains are configured, which tokens/recipients/amounts allowed — is
   * decided here.
   */
  function route(
    req: FacilitatorRequest,
    phase: "verify" | "settle",
  ): { handler: AnySchemeHandler; chain: ChainRuntime } | { error: string } {
    const reqs = req.paymentRequirements;
    if (req.x402Version !== 2) return { error: ErrorReason.INVALID_X402_VERSION };
    const resolved = resolveHandler(handlers, reqs);
    if ("error" in resolved) return resolved;
    const chain = chains.get(reqs.network);
    if (!chain) return { error: ErrorReason.INVALID_NETWORK };
    const policy = termsPolicy(chain, reqs);
    if (policy) return { error: policy };
    return { handler: resolved.handler, chain };
  }

  // Settle idempotency cache. The key binds the FULL settled terms
  // (network|scheme|asset|payTo|amount) plus the scheme's paymentId. Terms
  // alone already separate the collision case — a buyer reusing one EIP-3009
  // nonce across two payTo/amount pairs lands in two different terms — while
  // paymentId lets a scheme dedupe across *different* payloads that are the
  // same logical payment. For a phase-dependent scheme (upto) the amount is
  // left OUT: the settle-time figure is the seller's choice, and one
  // authorization must settle once whatever is asked for — a second settle
  // with a different amount (or a retry after a $0 settlement, which consumes
  // no on-chain nonce) returns the first result instead of drawing again.
  // Storing the Promise means concurrent requests submit once; the on-chain
  // nonce/period is the real guard past the cache window. The key is hashed
  // to bound its size against a hostile oversized identifier.
  const settling = new Map<string, Promise<SettleResponse>>();
  let lastSweep = 0;

  function settleKey(req: FacilitatorRequest, handler: AnySchemeHandler): string {
    const reqs = req.paymentRequirements;
    const amount = handler.phaseDependentAmount ? "*" : reqs.amount;
    const terms = `${reqs.network}|${reqs.scheme}|${canonicalAddress(reqs.asset)}|${canonicalAddress(reqs.payTo)}|${amount}`;
    const id = handler.paymentId(req.paymentPayload, reqs);
    return keccak256(toHex(`${terms}|${id}`));
  }

  /**
   * A retry against a PENDING entry is the moment to reconcile instead of
   * parroting "pending" until the TTL: if the broadcast tx has a receipt by
   * now, the verdict is known. Success replaces the entry; a revert evicts it
   * (the caller may legitimately retry); no receipt keeps it pending.
   */
  async function reconcilePending(
    key: string,
    chain: ChainRuntime,
    pending: SettleResponse,
    ttlMs: number,
  ): Promise<SettleResponse> {
    if (!pending.transaction) return pending;
    try {
      const receipt = await chain.ctx.publicClient.getTransactionReceipt({ hash: pending.transaction as Hex });
      if (receipt.status === "success") {
        const settled: SettleResponse = {
          success: true,
          transaction: pending.transaction,
          network: pending.network,
          ...(pending.payer ? { payer: pending.payer } : {}),
          ...(pending.amount ? { amount: pending.amount } : {}),
        };
        settling.set(key, Promise.resolve(settled));
        setTimeout(() => settling.delete(key), ttlMs).unref?.();
        return settled;
      }
      settling.delete(key);
      return { ...pending, transaction: "", errorReason: ErrorReason.INVALID_TRANSACTION_STATE };
    } catch {
      return pending; // not mined yet (or RPC hiccup) — still pending
    }
  }

  // /supported is fixed at construction time — never rebuilt per request.
  // kinds is not a chain × scheme cross product but filtered by the networks
  // each scheme declares; the signers' CAIP patterns come from the namespaces
  // actually configured.
  const supportedResponse: SupportedResponse = {
    kinds: [...chains.values()].flatMap((chain) =>
      handlers
        .filter((h) => h.networks.some((p) => matchesNetwork(p, chain.ctx.network)))
        .map((h) => {
          // Operator facts (token allowlist) plus whatever the scheme must
          // advertise (upto: the facilitatorAddress buyers bind into the witness)
          const extra = {
            ...(chain.tokens !== "*" ? { assets: chain.tokens.map((t) => t.address) } : {}),
            ...h.supportedExtra?.(account.address),
          };
          return {
            x402Version: 2 as const,
            scheme: h.scheme,
            network: chain.ctx.network,
            ...(Object.keys(extra).length ? { extra } : {}),
          };
        }),
    ),
    extensions: [],
    signers: Object.fromEntries(
      [...new Set([...chains.keys()].map((n) => n.split(":")[0]))].map((ns) => [
        `${ns}:*`,
        [account.address],
      ]),
    ),
  };

  return {
    signerAddress: account.address,

    async verify(req) {
      const invalid = validateRequest(req);
      if (invalid) return { isValid: false, invalidReason: invalid };
      const routed = route(req, "verify");
      if ("error" in routed) return { isValid: false, invalidReason: routed.error };
      return routed.handler.verify(req.paymentPayload, req.paymentRequirements, routed.chain.ctx);
    },

    async settle(req) {
      const invalid = validateRequest(req);
      // Echo the network only once it is known to be a short string — the raw
      // body is unvalidated at this point and must not be reflected verbatim
      const rawNetwork: unknown = req?.paymentRequirements?.network;
      const network = (typeof rawNetwork === "string" && caip2ChainId(rawNetwork) !== undefined ? rawNetwork : "") as Network;
      if (invalid) return { success: false, errorReason: invalid, transaction: "", network };
      const routed = route(req, "settle");
      if ("error" in routed) {
        return { success: false, errorReason: routed.error, transaction: "", network };
      }
      const { handler, chain } = routed;
      const reqs = req.paymentRequirements;
      const ttlMs = retentionTtlMs(reqs.maxTimeoutSeconds);

      const key = settleKey(req, handler);
      const pending = settling.get(key);
      if (pending) {
        // same terms + same payload → the first result (or a reconciled one)
        const result = await pending;
        return result.errorReason === ErrorReasonExtra.SETTLEMENT_PENDING
          ? reconcilePending(key, chain, result, ttlMs)
          : result;
      }

      // Load shedding BEFORE anything is broadcast: past the ceiling the honest
      // answer is "busy, retry", not a queue of nonces behind a slow RPC.
      if (chain.inflight >= maxInflight) {
        return { success: false, errorReason: ErrorReasonExtra.SETTLE_OVERLOADED, transaction: "", network };
      }

      // Backstop against unbounded growth if TTL eviction ever falls behind.
      // Evict only NON-pending entries — a pending entry is deliberately
      // retained for crash-safety and must survive the backstop. Throttled:
      // under sustained load a full sweep per request would be O(n) each.
      if (settling.size >= MAX_SETTLING_ENTRIES && Date.now() - lastSweep > SWEEP_INTERVAL_MS) {
        lastSweep = Date.now();
        for (const [k, p] of settling) {
          void p.then((r) => {
            if (r.errorReason !== ErrorReasonExtra.SETTLEMENT_PENDING) settling.delete(k);
          });
        }
      }

      const evict = (): void => void settling.delete(key);
      chain.inflight++;
      const task = handler
        .settle(req.paymentPayload, reqs, chain.ctx)
        .then((result) => {
          // Definite failures are evicted at once so a legitimate retry is
          // allowed. Successes AND pendings are retained for the TTL: a
          // success so a resend returns the same tx, a pending (broadcast but
          // unconfirmed — it MAY still land) so a retry reconciles instead of
          // resubmitting a possibly-successful transfer. Past the TTL the
          // chain's own nonce blocks reuse.
          const definiteFailure = !result.success && result.errorReason !== ErrorReasonExtra.SETTLEMENT_PENDING;
          if (definiteFailure) evict();
          else setTimeout(evict, ttlMs).unref?.();
          return result;
        })
        .catch((e) => {
          // A thrown settle must NOT leave a poisoned rejected promise cached
          evict();
          throw e;
        })
        .finally(() => {
          chain.inflight--;
        });
      settling.set(key, task);
      return task;
    },

    supported: () => supportedResponse,

    async health() {
      const entries = await Promise.all(
        [...chains.entries()].map(async ([network, chain]) => {
          try {
            const balance = await chain.ctx.publicClient.getBalance({ address: account.address });
            return [network, balance > 0n ? "ok" : "empty"] as const;
          } catch {
            return [network, "unreachable"] as const;
          }
        }),
      );
      return {
        ok: entries.every(([, status]) => status === "ok"),
        gas: Object.fromEntries(entries),
      };
    },

    async assertChainIds() {
      const mismatches = await Promise.all(
        [...chains.entries()].map(async ([network, chain]) => {
          const actual = await chain.ctx.publicClient.getChainId();
          return actual === chain.ctx.chainId ? undefined : `${network}: its RPC reports chain id ${actual}`;
        }),
      );
      const bad = mismatches.filter((m): m is string => m !== undefined);
      if (bad.length) throw new ConfigError(bad.join("; "));
    },
  };
}
