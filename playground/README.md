# x402-kit playground

A narrated, runnable demo of how x402-kit is actually used — **one command** and
you watch a seller server, a buyer, and a facilitator exchange real payments on
a local anvil chain. Nothing leaves your machine.

## Run

```bash
# requirements: Node 20+, foundry (anvil/cast/forge)
npm install
npm run playground          # all chapters, A → B → C
npm run playground -- b     # a single chapter (a | b | c)
```

## Payment scenario map — how real-world payments land on x402

Real-world payments split into four families. Each row says where it runs in
the demo — and when something doesn't run, why not.

**Group A — online, one payment per request**

| # | Scenario | Status |
|---|---|---|
| S1 | An agent/app calls a paid API — gets a 402, signs, retries (the M2M flow) | ▶ **runs in chapter A** |
| S2 | A person buys content — same wire as S1; only the signing UX (passkey wallet) differs | narrated in A |
| S3 | First-ever payment from an undeployed smart account (ERC-6492) | supported — needs a settler contract deployed, so outside the demo |
| S4 | Paying with a **plain ERC-20** (no EIP-3009) — via Permit2: one approve, signatures thereafter | ▶ **runs in chapter A** (every demo payment takes this permit2 path) |

**Group B — in-person (POS): the counter cannot wait for on-chain finality**

| # | Scenario | Status |
|---|---|---|
| S5 | QR-presented payment — the POS shows terms as a QR, the phone signs. **verify = authorize (instant, free) → hand over the goods → settle = capture (async)**. Isomorphic to card auth/capture | ▶ **runs in chapter B** |
| S6 | Open-amount in-person (fuel, deposits) — sign a cap, settle the actual | ▶ **runs in Chapter B2** (`upto`) |
| S7 | Fully offline (neither side online) — verify needs on-chain reads, so **double-spending cannot be prevented** | ✖ out of scope (an honest limit) |
| S8 | Void & refund — before capture: just don't settle (free); after: a reverse payment | narrated in B (refund helper planned) |

**Group C — recurring: authorize once, the seller charges per period**

| # | Scenario | Status |
|---|---|---|
| S9 | Fixed subscription (Netflix-style) — all installments pre-signed in **one signing ceremony** | ▶ **runs in chapter C** |
| S10 | Variable post-paid billing (utilities — any amount under a cap) | not built yet — being designed account-layer, where the payer's own smart account enforces the cap |
| S11 | Installments — same mechanism as S9, different numbers (amount × n) | narrated in C |
| S12 | Cancellation — for schedules, telling the seller to stop suffices (exposure never exceeds what was signed; on-chain invalidation of remaining installments is possible via Permit2 directly, kit helper planned). Account-layer: revoking the wallet permission IS the cancellation | schedules: works · account-layer: in design |
| S13 | Agent budget delegation — "this agent may spend up to X/month on its own" (the step beyond S1's M2M) | not built yet (account-layer) |

**Group D — prepaid**

| # | Scenario | Status |
|---|---|---|
| S14 | Prepaid wallet / gift card — **the token balance IS the prepaid wallet**, and a seller accepting its own token is the gift-card model | chapter A already is this shape (see its narration) |
| S15 | Transit (bus/subway taps) — taps stay off-chain records; **charge a capped daily aggregate** (post-paid transit) | not built yet — a special case of S10's account-layer design |

## Chapters

| Chapter | Scenarios | APIs used |
|---|---|---|
| **A** `a-online.ts` | S1 · S4 (+S2·S14 narration) | `withPaywall` · `permit2Terms` · `wrapFetch` · `approvePermit2` |
| **B** `b-pos.ts` | S5 (+S8 narration) | `buildPaymentRequired` · codecs · `signPayment` · `FacilitatorClient` |
| **B2** `b2-upto.ts` | S6 | `uptoTerms` · `facilitatorAddress` from `/supported` · `signPayment` · settle with `amount` = the actual |
| **C** `c-schedule.ts` | S9 (+S11·S10 narration) | `signPaymentSchedule` · `validateSchedule` · `dueEntries` · `chargeScheduled` |

## How to read it

Each chapter's `.ts` file IS the usage doc for its topic — read top to bottom.
The demo token is `e2e/contracts/TestToken.sol` ("Test KRW Stablecoin"/TKRW),
and every payment takes the x402 spec's permit2 transfer method (canonical
Permit2 + `x402ExactPermit2Proxy`, real bytecode vendored from Base). That path
never touches the token's EIP-3009 functions, so **a plain ERC-20 behaves
identically** — the demo token only carries EIP-3009 because it is shared with
the e2e harness.

Time warping (`anvil.increaseTime`) is demo-only — in production time simply
passes, and the seller's cron picks due installments with `dueEntries`.
