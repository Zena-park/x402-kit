/**
 * Facilitator configuration — a single file (facilitator-design §3).
 *
 * A token allowlist is the default. settle spends the operator's gas, so
 * opening up to arbitrary tokens ("*") — and their potentially malicious
 * transferWithAuthorization implementations — is an explicit opt-in only.
 *
 * The same doctrine applies to WHO may make the facilitator spend gas: the
 * HTTP server refuses to start unless /settle is protected by an API key, or
 * scoped by a payTo allowlist, or the operator explicitly declares
 * `unauthenticatedSettle: true` (local/test deployments behind a gateway).
 */

import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { caip2ChainId, parseAmount, type Network } from "@x402kit/core";

export interface TokenConfig {
  address: Address;
  name: string;
  version: string;
  /**
   * Smallest amount (atomic units) this facilitator will settle for the token.
   * A 1-wei self-transfer costs the operator the same gas as a real payment —
   * a floor makes the gas-drain attack pay for itself. Default: "1".
   */
  minAmount?: string;
}

export interface ChainConfig {
  /** CAIP-2, e.g. "eip155:84532" */
  network: Network;
  rpcUrl: string;
  /** Allowed tokens. "*" means allow all (explicit opt-in) */
  tokens: TokenConfig[] | "*";
  /** Erc6492Settler address — enables first payments from undeployed accounts */
  erc6492Settler?: Address;
  /** Permit2 contract override (exact/permit2). Default: the canonical CREATE2 address */
  permit2Address?: Address;
  /** x402ExactPermit2Proxy override (exact/permit2). Default: the canonical CREATE2 address */
  permit2Proxy?: Address;
  /** x402UptoPermit2Proxy override (upto). Default: the canonical CREATE2 address */
  uptoPermit2Proxy?: Address;
  /** Gas ceiling per settlement tx (simulation and broadcast). Default 300_000 */
  maxSettleGas?: number;
  /** Gas ceiling for the ERC-6492 deploy-and-settle path. Default 1_500_000 */
  maxErc6492SettleGas?: number;
}

export interface FacilitatorConfig {
  port?: number;
  chains: ChainConfig[];
  /** Name of the env var holding the settlement key. Default PRIVATE_KEY */
  signerKeyEnv?: string;
  /**
   * Name of the env var holding the API key callers must present on
   * POST /settle (and /verify) as `authorization: Bearer <key>` or
   * `x-api-key: <key>`. Default SETTLE_API_KEY. When the variable is unset
   * the endpoint is unauthenticated — see `unauthenticatedSettle`.
   */
  settleApiKeyEnv?: string;
  /**
   * Only settle payments whose recipient is one of these addresses — scopes
   * the facilitator to your own sellers so a stranger holding an allowlisted
   * token cannot settle a self-transfer on your gas.
   */
  allowedPayTo?: Address[];
  /**
   * Explicitly run /settle with neither an API key nor a payTo allowlist.
   * The HTTP server refuses to start otherwise — an open facilitator is a
   * free gas relay. Embedded (in-process) facilitators ignore this.
   */
  unauthenticatedSettle?: boolean;
  /**
   * Per-client-IP request budget for POST /verify and /settle, in requests
   * per minute (token bucket). 0 disables. Default 300.
   */
  rateLimitPerMinute?: number;
  /**
   * Take the client IP for rate limiting from the first `x-forwarded-for`
   * hop instead of the socket address. Set ONLY when a reverse proxy you
   * control sits in front — otherwise every client shares the proxy's IP
   * (and one bucket), or a direct client can spoof the header. Default false.
   */
  trustProxy?: boolean;
  /**
   * Upper bound on settlements in flight per chain; callers beyond it get
   * `settle_overloaded` (HTTP 503, retry-after) instead of piling nonces up
   * behind a slow RPC. Default 16.
   */
  maxInflightSettles?: number;
}

export class ConfigError extends Error {}

/** CAIP-2 → chainId. Derived, so never stored — call it where needed */
export function chainIdOf(network: Network): number {
  const id = caip2ChainId(network);
  if (id === undefined) {
    throw new ConfigError(`only EVM (eip155:*) networks are supported: ${network}`);
  }
  return id;
}

export interface ResolvedConfig extends FacilitatorConfig {
  port: number;
  signerKey: `0x${string}`;
  /** Resolved API key, if the env var was set */
  settleApiKey?: string;
}

function assertAddress(label: string, address: string): void {
  try {
    getAddress(address);
  } catch {
    throw new ConfigError(`${label} is not a valid address: ${address}`);
  }
}

export function loadConfig(path: string): ResolvedConfig {
  let raw: FacilitatorConfig;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as FacilitatorConfig;
  } catch (e) {
    throw new ConfigError(`cannot read config file (${path}): ${(e as Error).message}`);
  }

  if (!raw.chains?.length) throw new ConfigError("chains is empty");

  const seen = new Set<Network>();
  for (const chain of raw.chains) {
    if (seen.has(chain.network)) throw new ConfigError(`duplicate network: ${chain.network}`);
    seen.add(chain.network);
    chainIdOf(chain.network); // format validation — fail at startup, not at request time
    if (!chain.rpcUrl) throw new ConfigError(`${chain.network}: rpcUrl is missing`);
    if (chain.tokens !== "*") {
      for (const t of chain.tokens) {
        assertAddress(`${chain.network}: token`, t.address);
        if (t.minAmount !== undefined && parseAmount(t.minAmount) === undefined) {
          throw new ConfigError(`${chain.network}: token ${t.address} minAmount must be a decimal atomic-unit string`);
        }
      }
    }
    // Contract-address overrides get the same startup validation as tokens —
    // a typo'd proxy would otherwise surface as invalid_payload at request time
    for (const key of ["erc6492Settler", "permit2Address", "permit2Proxy", "uptoPermit2Proxy"] as const) {
      const address = chain[key];
      if (address !== undefined) assertAddress(`${chain.network}: ${key}`, address);
    }
    for (const key of ["maxSettleGas", "maxErc6492SettleGas"] as const) {
      const v = chain[key];
      if (v !== undefined && (!Number.isInteger(v) || v <= 0)) {
        throw new ConfigError(`${chain.network}: ${key} must be a positive integer`);
      }
    }
  }
  for (const address of raw.allowedPayTo ?? []) assertAddress("allowedPayTo entry", address);
  for (const key of ["rateLimitPerMinute", "maxInflightSettles"] as const) {
    const v = raw[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new ConfigError(`${key} must be a non-negative integer`);
  }

  const keyEnv = raw.signerKeyEnv ?? "PRIVATE_KEY";
  const signerKey = process.env[keyEnv];
  // Validate the full shape here so a malformed key never reaches
  // privateKeyToAccount, whose thrown error could echo the key material.
  if (!signerKey || !/^0x[0-9a-fA-F]{64}$/.test(signerKey)) {
    throw new ConfigError(`settlement key missing or malformed — env var ${keyEnv} must be a 0x-prefixed 32-byte hex private key`);
  }
  // The key has been read; do not leave it sitting in process.env for the
  // lifetime of the process (child processes, /proc/<pid>/environ, crash
  // dumps of the env). createFacilitator scrubs the config copy likewise.
  delete process.env[keyEnv];

  const apiKeyEnv = raw.settleApiKeyEnv ?? "SETTLE_API_KEY";
  const settleApiKey = process.env[apiKeyEnv];
  if (settleApiKey !== undefined) delete process.env[apiKeyEnv];

  return {
    ...raw,
    port: raw.port ?? 4021,
    signerKey: signerKey as `0x${string}`,
    ...(settleApiKey ? { settleApiKey } : {}),
  };
}

/**
 * Refuse to expose an open gas relay by accident — the operator must say so.
 * Part of the config doctrine (so embedded operators can apply it too); the
 * turnkey server calls it before listening.
 */
export function assertSettleExposure(config: ResolvedConfig): void {
  if (config.settleApiKey || config.allowedPayTo?.length || config.unauthenticatedSettle) return;
  throw new ConfigError(
    `POST /settle would be open to anyone: set ${config.settleApiKeyEnv ?? "SETTLE_API_KEY"}, or scope with allowedPayTo, ` +
      `or declare "unauthenticatedSettle": true (local/test only, behind your own gateway)`,
  );
}
