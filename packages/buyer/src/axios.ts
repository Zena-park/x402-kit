/**
 * Axios adapter — the same buyer safety model as wrapFetch, for axios clients.
 *
 *   import axios from "axios";
 *   import { attachX402 } from "@x402.kit/buyer/axios";
 *   attachX402(axios, { signer, maxAmount: "1000000" });
 *
 * Typed structurally so axios is not a dependency. The awkward part axios
 * forces on us: a 402 arrives as a *rejected* promise (any non-2xx does), so
 * we hook the response interceptor's rejection arm, pay, and re-issue the
 * request once — guarded by a per-request flag so a persistent 402 can't loop.
 *
 * The full policy surface of WrapFetchOptions applies (maxAmount cap, asset
 * allowlist, validity clamp, consent) — payment building goes through the same
 * signPayment path.
 */

import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodePaymentRequiredSafe,
  decodeSettleResponseSafe,
} from "@x402.kit/core";
import {
  SKIP_CROSS_ORIGIN,
  SKIP_REDIRECTED,
  assertBuyerPolicy,
  createSpendTracker,
  preparePayment,
  type WrapFetchOptions,
} from "./wrapFetch.js";

/** Minimal structural shape of the axios instance we touch */
interface AxiosLike {
  interceptors: {
    response: {
      use(onFulfilled: (r: AxiosResponseLike) => unknown, onRejected: (e: unknown) => unknown): number;
    };
  };
  request(config: AxiosRequestLike): Promise<AxiosResponseLike>;
}

interface AxiosRequestLike {
  url?: string;
  headers?: Record<string, unknown>;
  /** set by us to guard against a retry loop */
  __x402Retried__?: boolean;
  [key: string]: unknown;
}

interface AxiosResponseLike {
  status: number;
  headers: Record<string, unknown> & { get?(name: string): string | null };
  config: AxiosRequestLike;
  /** Node adapter exposes `res.responseUrl`; the browser XHR adapter exposes `responseURL` */
  request?: { res?: { responseUrl?: string }; responseURL?: string };
  data?: unknown;
}

/** Best-effort origin of a request/response for the cross-origin guard (Node AND browser shapes) */
function originOf(config: AxiosRequestLike, response?: AxiosResponseLike): string | undefined {
  const url =
    response?.request?.res?.responseUrl ??
    response?.request?.responseURL ??
    (typeof config.url === "string" ? config.url : undefined);
  const base = typeof config["baseURL"] === "string" ? (config["baseURL"] as string) : undefined;
  try {
    return new URL(url ?? "", base).origin;
  } catch {
    return undefined;
  }
}

function headerValue(headers: AxiosResponseLike["headers"], name: string): string | undefined {
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v;
  }
  return undefined;
}

/**
 * Attach x402 payment handling to an axios instance. Returns the same instance.
 */
export function attachX402<T extends AxiosLike>(axios: T, options: WrapFetchOptions): T {
  assertBuyerPolicy(options);
  const spend = createSpendTracker(options.maxTotalAmount);

  const onError = async (error: unknown): Promise<AxiosResponseLike> => {
    const response = (error as { response?: AxiosResponseLike }).response;
    const config = response?.config;
    if (!response || !config || response.status !== 402 || config.__x402Retried__) {
      throw error; // not a payable 402, or already retried once
    }

    const header = headerValue(response.headers, HEADER_PAYMENT_REQUIRED);
    if (!header) throw error;
    const decoded = decodePaymentRequiredSafe(header);
    if (!decoded.ok) throw error;

    const prepared = await preparePayment(decoded.value.accepts, options, spend);
    if ("skipped" in prepared) {
      options.onSkipped?.(prepared.skipped, decoded.value.accepts);
      throw error; // policy refusal — surface the original 402 rejection
    }

    // The signed payload is a bearer instrument. Do NOT let axios follow a
    // redirect with it attached (a 3xx to another origin would hand the
    // authorization to a third party) — pin maxRedirects: 0 (Node adapter)
    // and `redirect: "manual"` (fetch adapter), and refuse to forward on any
    // 3xx or cross-origin response, mirroring wrapFetch. NOTE: the browser
    // XHR adapter cannot suppress redirects at all — the browser follows them
    // transparently, header included. In browsers prefer `adapter: "fetch"`.
    const firstOrigin = originOf(config, response);
    let retried: AxiosResponseLike;
    try {
      retried = await axios.request({
        ...config,
        __x402Retried__: true,
        maxRedirects: 0,
        fetchOptions: { ...(config["fetchOptions"] as object | undefined), redirect: "manual" },
        headers: { ...config.headers, [HEADER_PAYMENT_SIGNATURE]: prepared.header },
      });
    } catch (e) {
      // Only a transport failure means the seller never saw the signature.
      if (!(e as { response?: unknown }).response) prepared.refund();
      throw e;
    }

    if (retried.status >= 300 && retried.status < 400) {
      options.onSkipped?.(SKIP_REDIRECTED, decoded.value.accepts);
      return retried;
    }
    const retryOrigin = originOf(retried.config ?? config, retried);
    if (firstOrigin && retryOrigin && retryOrigin !== firstOrigin) {
      options.onSkipped?.(SKIP_CROSS_ORIGIN, decoded.value.accepts);
      return retried;
    }

    if (retried.status >= 200 && retried.status < 300) {
      const settleHeader = headerValue(retried.headers, HEADER_PAYMENT_RESPONSE);
      // Safe decode — a malformed receipt header must not fail a paid request.
      const settlement = settleHeader ? decodeSettleResponseSafe(settleHeader) : undefined;
      options.onPaid?.(prepared.chosen, settlement);
    }
    return retried;
  };

  axios.interceptors.response.use((r) => r, onError);
  return axios;
}
