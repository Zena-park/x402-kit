/**
 * Facilitator client — the spec §7 HTTP API from the seller's side.
 *
 * FacilitatorLike is the structural contract: a remote URL wrapped by
 * FacilitatorClient satisfies it, and so does an embedded
 * `createFacilitator()` instance from @x402kit/facilitator — the paywall
 * accepts either without knowing the difference.
 *
 * Transport failures throw FacilitatorUnreachableError so the seller can tell
 * "facilitator is down, retry" (→ 502/503) apart from "payment rejected"
 * (a normal VerifyResponse/SettleResponse with success:false).
 */

import type {
  FacilitatorRequest,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402kit/core";

export interface FacilitatorLike {
  verify(req: FacilitatorRequest): Promise<VerifyResponse>;
  settle(req: FacilitatorRequest): Promise<SettleResponse>;
}

export interface FacilitatorClientOptions {
  fetchImpl?: typeof fetch;
  /** Per-call bound for verify/settle/supported. Default 30 s */
  timeoutMs?: number;
  /**
   * API key presented as `authorization: Bearer <key>` — what the turnkey
   * facilitator's SETTLE_API_KEY expects.
   */
  apiKey?: string;
  /**
   * Silence the plaintext warning. The signed payload is a bearer credential
   * for one transfer; over `http://` anyone on the path can copy it and
   * front-run the settlement. Loopback hosts never warn.
   */
  allowInsecure?: boolean;
}

/** The "URL or FacilitatorLike" convention, resolved in one place */
export function toFacilitator(facilitator: FacilitatorLike | string): FacilitatorLike {
  return typeof facilitator === "string" ? new FacilitatorClient(facilitator) : facilitator;
}

/** The facilitator could not be reached or returned a non-JSON/5xx response */
export class FacilitatorUnreachableError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(`facilitator ${endpoint} unreachable${status ? ` (HTTP ${status})` : ""}`);
    this.name = "FacilitatorUnreachableError";
    if (cause !== undefined) this.cause = cause;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isBoolean(v: unknown, key: string): boolean {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)[key] === "boolean";
}

export class FacilitatorClient implements FacilitatorLike {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;

  constructor(baseUrl: string, options: FacilitatorClientOptions = {}) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`facilitator URL is not absolute: ${baseUrl}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`facilitator URL must be http(s): ${baseUrl}`);
    }
    if (url.protocol === "http:" && !LOOPBACK.has(url.hostname) && !options.allowInsecure) {
      console.warn(
        `[x402kit/seller] facilitator ${url.origin} is plain http — signed payments (bearer credentials) travel unencrypted. ` +
          `Use https, or pass allowInsecure: true to acknowledge.`,
      );
    }
    // Normalize so endpoint paths append cleanly (no query/fragment bleed-through).
    url.search = "";
    url.hash = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    this.baseUrl = url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.apiKey = options.apiKey;
  }

  private endpoint(path: string): string {
    return new URL(path.replace(/^\//, ""), this.baseUrl).toString();
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async post<T>(path: string, body: FacilitatorRequest, shapeKey: string): Promise<T> {
    let res: Response;
    try {
      // Bound the call — a hung or hostile facilitator must not pin the
      // seller's request (and, in sync mode, the buyer's) indefinitely.
      res = await this.fetchImpl(this.endpoint(path), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new FacilitatorUnreachableError(path, undefined, e);
    }
    // A settlement_pending / overloaded 503 still carries a JSON body the caller wants.
    if (!res.ok && res.status !== 503) {
      throw new FacilitatorUnreachableError(path, res.status);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (e) {
      throw new FacilitatorUnreachableError(path, res.status, e);
    }
    // The paywall branches on `isValid` / `success` — a string "false" or a
    // number 1 from a broken or hostile facilitator must not read as truthy.
    if (!isBoolean(parsed, shapeKey)) throw new FacilitatorUnreachableError(path, res.status, new Error("malformed response"));
    return parsed as T;
  }

  verify(req: FacilitatorRequest): Promise<VerifyResponse> {
    return this.post<VerifyResponse>("/verify", req, "isValid");
  }

  settle(req: FacilitatorRequest): Promise<SettleResponse> {
    return this.post<SettleResponse>("/settle", req, "success");
  }

  async supported(): Promise<SupportedResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint("/supported"), {
        headers: this.headers(false),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new FacilitatorUnreachableError("/supported", undefined, e);
    }
    if (!res.ok) throw new FacilitatorUnreachableError("/supported", res.status);
    const parsed = (await res.json()) as SupportedResponse;
    if (!Array.isArray(parsed?.kinds)) throw new FacilitatorUnreachableError("/supported", res.status, new Error("malformed response"));
    return parsed;
  }
}
