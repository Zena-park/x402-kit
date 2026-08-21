#!/usr/bin/env node
/**
 * Turnkey server — createFacilitator wrapped in node:http.
 *
 * Endpoints follow spec §7 exactly, so standard clients connect by changing
 * nothing but the URL.
 *   POST /verify      free, instant, never mutates chain state
 *   POST /settle      on-chain settlement; gas is paid here
 *   GET  /supported   advertise what this facilitator handles
 *   GET  /health      liveness and coarse gas status
 *
 * A failed verification is still HTTP 200 — rejecting a payment is a normal
 * protocol-level answer, not an HTTP error.
 *
 * Exposure controls (all in the config file / env):
 *   - SETTLE_API_KEY gates POST /verify and /settle (Bearer or x-api-key).
 *     Without it, and without `allowedPayTo`, the server refuses to start
 *     unless `unauthenticatedSettle: true` is declared — an open /settle is a
 *     free gas relay.
 *   - a per-IP token bucket on the POST endpoints (default 300/min) keeps one
 *     client from exhausting the upstream RPC quota.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ErrorReasonExtra, type FacilitatorRequest } from "@x402kit/core";
import { ConfigError, assertSettleExposure, loadConfig, type ResolvedConfig } from "./config.js";
import { createFacilitator, type Facilitator } from "./facilitator.js";

export { assertSettleExposure };

/** Payment payloads are a few KB; anything larger is abuse */
const MAX_BODY_BYTES = 64 * 1024;

/** /health is cheap to serve from memory and expensive to serve from the RPC */
const HEALTH_CACHE_MS = 10_000;

const DEFAULT_RATE_LIMIT_PER_MINUTE = 300;

/** Settle outcomes that are "try again later", with the retry-after each deserves (seconds) */
const TRANSIENT_RETRY_AFTER: Record<string, string> = {
  [ErrorReasonExtra.SETTLEMENT_PENDING]: "10",
  [ErrorReasonExtra.SETTLE_OVERLOADED]: "2",
};

class BodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Structured logging — untrusted fields (payer, reason) are JSON-encoded, never
// interpolated into a line, so they cannot forge log entries or inject ANSI.
function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new BodyError(415, "content-type must be application/json");

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new BodyError(413, "request body too large");
    }
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new BodyError(400, "invalid JSON");
  }
}

/** Constant-time string compare — an API key check must not leak length/prefix via timing */
function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function presentedKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey : undefined;
}

/** Strip anything URL-shaped (RPC endpoints often carry a provider key in the path/query) */
function redactUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "<url>");
}

function rateLimited(res: ServerResponse): void {
  res.setHeader("retry-after", "1");
  json(res, 429, { error: "rate_limited" });
}

/** Socket address, or the first x-forwarded-for hop when the operator trusts the proxy in front */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const raw = req.headers["x-forwarded-for"];
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "?";
}

/**
 * Per-IP token bucket. Bounded: the map is swept of full buckets so an
 * address-rotating flood cannot grow it without bound.
 */
function createRateLimiter(perMinute: number): (ip: string) => boolean {
  if (perMinute <= 0) return () => true;
  const refillPerMs = perMinute / 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  let lastSweep = Date.now();
  return (ip) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [k, b] of buckets) if (b.tokens + (now - b.at) * refillPerMs >= perMinute) buckets.delete(k);
      lastSweep = now;
    }
    const b = buckets.get(ip) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + (now - b.at) * refillPerMs);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(ip, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    return true;
  };
}

export function createRequestHandler(
  facilitator: Facilitator,
  config: ResolvedConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  const allow = createRateLimiter(config.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE);
  let healthCache: { at: number; value: Awaited<ReturnType<Facilitator["health"]>> } | undefined;

  return (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    const run = async (): Promise<void> => {
      if (method === "POST" && (url === "/verify" || url === "/settle")) {
        // Auth first, then the bucket — and failed auth draws from its own
        // bucket, so an unauthenticated flood from the address a proxy shares
        // with legitimate callers cannot exhaust THEIR budget.
        const ip = clientIp(req, config.trustProxy ?? false);
        if (config.settleApiKey) {
          const key = presentedKey(req);
          if (!key || !sameSecret(key, config.settleApiKey)) {
            if (!allow(`unauthenticated:${ip}`)) return rateLimited(res);
            return json(res, 401, { error: "unauthorized" });
          }
        }
        if (!allow(ip)) return rateLimited(res);
      }
      if (method === "POST" && url === "/verify") {
        const body = await readJson<FacilitatorRequest>(req);
        const result = await facilitator.verify(body);
        log("verify", { valid: result.isValid, reason: result.invalidReason, payer: result.payer });
        return json(res, 200, result);
      }
      if (method === "POST" && url === "/settle") {
        const body = await readJson<FacilitatorRequest>(req);
        const result = await facilitator.settle(body);
        log("settle", { success: result.success, tx: result.transaction, reason: result.errorReason, payer: result.payer });
        // Transient answers get 503 + retry-after so a seller can tell
        // "reconcile/retry" from "payment rejected". A pending body still
        // carries the tx hash for reconciliation.
        const retryAfter = TRANSIENT_RETRY_AFTER[result.errorReason ?? ""];
        if (retryAfter) {
          res.setHeader("retry-after", retryAfter);
          return json(res, 503, result);
        }
        return json(res, 200, result);
      }
      if (method === "GET" && url === "/supported") return json(res, 200, facilitator.supported());
      if (method === "GET" && url === "/health") {
        if (!healthCache || Date.now() - healthCache.at > HEALTH_CACHE_MS) {
          healthCache = { at: Date.now(), value: await facilitator.health() };
        }
        return json(res, healthCache.value.ok ? 200 : 503, healthCache.value);
      }
      json(res, 404, { error: "not_found" });
    };

    run().catch((e) => {
      if (e instanceof BodyError) return json(res, e.status, { error: e.message });
      log("error", { message: (e as Error).message });
      json(res, 500, { error: "internal_error" });
    });
  };
}

async function main(): Promise<void> {
  const configPath = process.env.FACILITATOR_CONFIG ?? "facilitator.config.json";
  const config = loadConfig(configPath);
  assertSettleExposure(config);
  const facilitator = createFacilitator(config);
  await facilitator.assertChainIds();

  const server = createServer(createRequestHandler(facilitator, config));

  // Bound slow-loris and header floods (payment requests are small and quick)
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  server.listen(config.port, () => {
    log("started", {
      port: config.port,
      signer: facilitator.signerAddress,
      settleAuth: config.settleApiKey ? "api-key" : config.allowedPayTo?.length ? "payTo-allowlist" : "NONE",
      chains: config.chains.map((c) => ({
        network: c.network,
        tokens: c.tokens === "*" ? "*" : c.tokens.map((t) => t.address),
      })),
    });
  });
}

// Run only as an entrypoint — the handler is also importable for tests/embedding.
if (process.argv[1] && /server\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    if (e instanceof ConfigError) {
      console.error(`\nconfiguration error\n  ${e.message}\n`);
      process.exit(2);
    }
    // Not the full error: viem transport errors embed the RPC URL, which
    // commonly carries a provider API key. Name + short message is enough.
    const err = e as { name?: string; shortMessage?: string; message?: string };
    console.error(`\nstartup failed: ${err?.name ?? "Error"}: ${redactUrls(err?.shortMessage ?? err?.message ?? String(e))}\n`);
    process.exit(1);
  });
}
