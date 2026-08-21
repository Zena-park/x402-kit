/**
 * Seller-side replay guard.
 *
 * Verification is a pure on-chain READ: a payment's nonce is only consumed
 * once its settlement is MINED. Until then — and in async / after-handler /
 * none modes, forever from the request's point of view — the same
 * PAYMENT-SIGNATURE header verifies again and again. Without a seller-side
 * claim, one signed payment buys N concurrent deliveries while the
 * facilitator's idempotency cache collapses the N settles into one transfer.
 *
 * The store answers one question: "has this payment identity been claimed by
 * a request already?" The identity is the scheme's own `paymentId` (the
 * SIGNED (from, nonce) for exact — nothing a buyer can vary without a fresh
 * signature). A claim is released when the payment turns out to be invalid or
 * definitively fails to settle, so a legitimate retry is not locked out.
 *
 * The default store is in-process. Run several seller instances behind one
 * balancer and each has its own memory — back it with Redis (`SET NX PX`)
 * via this interface instead.
 */

export interface ReplayStore {
  /** Atomically claim `id` for `ttlMs`. false when it is already held */
  claim(id: string, ttlMs: number): boolean | Promise<boolean>;
  /** Give the id back (payment rejected / settle definitively failed) */
  release(id: string): void | Promise<void>;
}

/** Bounded in-memory TTL store — the default. `maxEntries` is a runaway backstop */
export function createMemoryReplayStore(maxEntries = 100_000): ReplayStore {
  const held = new Map<string, number>(); // id → expiry (ms)
  let lastSweep = 0;
  // A full sweep is O(n); at the cap with mostly-live claims it would run on
  // every claim and free little — so at most once a second, then fall through
  // to oldest-first eviction.
  function sweep(now: number): void {
    if (now - lastSweep < 1000) return;
    lastSweep = now;
    for (const [id, until] of held) if (until <= now) held.delete(id);
  }
  return {
    claim(id, ttlMs) {
      const now = Date.now();
      const until = held.get(id);
      if (until !== undefined && until > now) return false;
      if (held.size >= maxEntries) sweep(now);
      // Still full after sweeping expired entries: evict the oldest (Map keeps
      // insertion order) rather than refusing payments outright.
      if (held.size >= maxEntries) held.delete(held.keys().next().value as string);
      held.set(id, now + ttlMs);
      return true;
    },
    release(id) {
      held.delete(id);
    },
  };
}
