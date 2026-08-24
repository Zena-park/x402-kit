# 판매자 가이드 — API에 x402 결제 게이트 붙이기

이 가이드는 **판매자(seller)** 입장의 문서입니다. 이미 동작하는 HTTP API가 있고,
그중 일부 라우트를 "결제해야 응답하는" 엔드포인트로 바꾸고 싶은 서버 개발자를
위한 것입니다. 구매자 측(지갑으로 결제하는 프론트엔드)은
[`dapp-guide.ko.md`](./dapp-guide.ko.md), facilitator 운영은
[`operator-guide.ko.md`](./operator-guide.ko.md)를 보세요.

판매자가 하는 일은 딱 세 가지입니다:

1. **조건(terms)을 정한다** — 어떤 체인에서, 어떤 토큰으로, 얼마를, 어디로 받을지.
2. **라우트를 `paywall`로 감싼다** — 결제 없으면 402, 결제 있으면 검증·정산 후 핸들러 실행.
3. **facilitator를 가리킨다** — 온체인 검증과 정산을 대신해주는 서버 URL.

판매자 서버는 개인키도, RPC 연결도, 가스도 필요 없습니다. 그건 전부 facilitator의
몫입니다.

---

## 0. 설치와 전체 그림

```bash
npm i @x402.kit/seller @x402.kit/core
```

```
구매자 ──(1) GET /premium──────────────▶ 판매자
      ◀─(2) 402 + PAYMENT-REQUIRED ────
      ──(3) GET /premium + PAYMENT-SIGNATURE ─▶ 판매자 ──verify/settle──▶ facilitator ──tx──▶ 체인
      ◀─(4) 200 + PAYMENT-RESPONSE(tx hash) ──
```

`paywall`이 (2)~(4)를 전부 처리합니다. 여러분의 핸들러는 결제가 끝난 뒤에만 실행됩니다.

---

## 1. 결제 조건(terms) 정하기

402 응답의 `accepts[]`에 들어가는 `PaymentRequirements` 객체입니다. 직접 쓰면 이렇습니다:

```ts
const terms = {
  scheme: "exact",                 // 정액 결제
  network: "eip155:8453",          // CAIP-2 형식 (Base 메인넷)
  asset: TOKEN_ADDRESS,            // ERC-20 주소
  amount: "10000",                 // atomic 단위 (USDC 6 decimals → 0.01 USDC)
  payTo: MY_ADDRESS,               // 수취 주소
  maxTimeoutSeconds: 60,           // 서명 유효 시간
  extra: { name: "USD Coin", version: "2" },  // 토큰의 EIP-712 도메인 — 필수
};
```

`extra`의 `name`/`version`은 토큰 컨트랙트의 EIP-712 도메인과 **정확히** 일치해야
합니다. 틀리면 구매자 서명이 검증에서 전부 실패합니다. 손으로 쓰지 말고 헬퍼를
쓰세요:

### 1a. EIP-3009 토큰 (USDC 등) — `erc3009Terms`

토큰에서 도메인을 직접 읽어옵니다(ERC-5267). RPC 읽기가 필요하므로 비동기이며,
서버 부팅 시 한 번만 호출해 캐시하면 됩니다:

```ts
import { erc3009Terms } from "@x402.kit/seller";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });

const terms = await erc3009Terms({
  network: "eip155:8453",
  asset: USDC,
  payTo: MY_ADDRESS,
  amount: "10000",
  publicClient,
});
```

### 1b. 일반 ERC-20 (EIP-3009 미지원) — `permit2Terms`

대부분의 ERC-20이 여기 해당합니다. Permit2를 통해 정산되며, 도메인도 RPC도 필요
없어 동기 함수입니다:

```ts
import { permit2Terms } from "@x402.kit/seller";

const terms = permit2Terms({ network: "eip155:8453", asset: MY_TOKEN, payTo: MY_ADDRESS, amount: "10000" });
// terms.extra.assetTransferMethod === "permit2"
```

구매자는 이 토큰에 대해 Permit2 `approve`를 **한 번** 해야 합니다
(`@x402.kit/buyer`의 `approvePermit2`). 판매자가 할 일은 없지만, 문서나 UI에서
구매자에게 안내해 주는 것이 좋습니다.

### 과금 모델 둘: 고정가(`exact`) 또는 상한(`upto`)

`exact`는 **요청당 고정 금액**입니다 — "호출당 $0.01", "리포트 한 건 $2". `upto`는
**일을 끝낸 뒤에야 금액을 아는** 경우를 위한 것입니다 — 출력 토큰으로 청구하는 AI
호출, 연료 충전, 보증금: 구매자가 **상한**에 서명하고, 핸들러가 측정하고, 실액(≤ 상한,
`"0"` 가능)을 정산합니다. 상한 하나는 한 번만 인출됩니다. 기간당 청구는 §7의 사전
서명 스케줄을 쓰세요.

```ts
import { uptoTerms, SETTLEMENT_OVERRIDES_HEADER } from "@x402.kit/seller";

// 1. 조건: 상한과, facilitator의 /supported에서 읽은 주소 (kinds[].extra.facilitatorAddress)
const terms = uptoTerms({ network, asset: USDC, payTo: MY_ADDRESS, maxAmount: "1000000", facilitatorAddress });

// 2. after-handler 모드: 핸들러가 실제 금액을 지정하면 어댑터가 그 금액으로 정산
app.use("/v1/answer", paywall({ accepts: [terms], facilitator: FACILITATOR_URL, settle: "after-handler", onSettled }));
app.post("/v1/answer", async (c) => {
  const { text, usage } = await model.complete(await c.req.json());
  c.header(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: priceFor(usage) })); // atomic 단위, ≤ 상한
  return c.json({ text });
});
```

코어를 직접 쓰면 `decision.capture({ amount })`를 직접 호출하세요. 참고: upto는
Permit2 전용입니다(구매자는 exact/permit2와 같은 1회성 `approvePermit2`); facilitator가
`upto`를 광고하고 그 주소를 조건에 바인딩해야 구매자가 서명할 수 있습니다;
`Settlement-Overrides` 헤더는 응답이 나가기 전에 제거됩니다; 상한을 넘는 금액은
facilitator까지 가지 않고 `onSettled`로 로컬 실패합니다. 훅형 express/fastify는
핸들러보다 먼저 실행되므로 이 방식을 쓸 수 없습니다 — hono, next 또는 코어를 쓰세요.
순수 node:http에서는 코어를 직접 제어해 `res.end()` **전에** `capture({ amount })`하세요
(`examples/metered-api.ts` 참고): node `withPaywall` 래퍼는 핸들러가 응답을 끝낸 뒤에
capture하므로, 구매자가 `onPaid`로 기록하는 실액 영수증이 전달되지 않습니다.

### 여러 조건 제시하기

`accepts`는 배열입니다. 체인 두 개, 토큰 두 개를 동시에 받고 싶으면 항목을 여러 개
넣으세요. 구매자 측 `wrapFetch`가 자기 허용 목록과 교집합을 골라 결제합니다.

---

## 2. 라우트 감싸기

### Hono

```ts
import { Hono } from "hono";
import { paywall } from "@x402.kit/seller/hono";

const app = new Hono();
app.use("/premium/*", paywall({ accepts: [terms], facilitator: FACILITATOR_URL }));
app.get("/premium/report", (c) => c.json({ data: "..." }));
```

### Express

```ts
import express from "express";
import { paywall } from "@x402.kit/seller/express";

const app = express();
app.use("/premium", paywall({ accepts: [terms], facilitator: FACILITATOR_URL }));
app.get("/premium/report", (req, res) => res.json({ data: "..." }));
```

### Fastify

```ts
import { paywall } from "@x402.kit/seller/fastify";

fastify.addHook("preHandler", paywall(options));        // 전역
// 또는 라우트별
fastify.get("/premium/report", { preHandler: paywall(options) }, handler);
```

### Next.js (App Router)

```ts
// app/api/premium/route.ts
import { withPaywall } from "@x402.kit/seller/next";

export const GET = withPaywall(options, async (req) => Response.json({ data: "..." }));
```

### 프레임워크 없음 (`node:http`)

```ts
import { withPaywall } from "@x402.kit/seller/node";
import { createServer } from "node:http";

createServer(withPaywall(options, (req, res) => { res.end("paid content"); })).listen(3000);
```

### 그 밖의 모든 것 — 코어 직접 사용

어댑터는 전부 `createPaywall(options).check(request)` 위에 얹힌 10~15줄입니다.
웹 표준 `Request`/`Response`를 쓰는 런타임(Deno, Bun, Cloudflare Workers,
SvelteKit 등)이라면 직접 호출하세요:

```ts
import { createPaywall } from "@x402.kit/seller";

const gate = createPaywall(options);

export default async function handler(request: Request): Promise<Response> {
  const decision = await gate.check(request);
  if (!decision.paid) return decision.response;             // 402 또는 503 — 그대로 반환

  const body = await doTheWork();
  return new Response(body, { headers: decision.responseHeaders }); // 기본 "sync" 모드에서 PAYMENT-RESPONSE 포함
}
```

코어를 직접 쓰면서 `settle: "after-handler"`를 쓴다면, decision에 담긴 `capture()`를
핸들러 성공 후 **반드시 직접 호출**해야 합니다 — 래퍼 어댑터는 대신 해주지만, 직접
만든 통합에서 잊으면 정산이 영영 일어나지 않습니다. `async` / `none` /
`after-handler` 모드에서는 `responseHeaders`가 비어 있고, tx hash는 `onSettled`(또는
`capture()`의 반환값)로 옵니다.

hono/express/fastify는 **의존성이 아닙니다** — 타입만 구조적으로 맞추므로, 설치한
버전이 무엇이든 동작합니다.

### MCP 도구 — HTTP 없이 같은 paywall

에이전트에게 MCP(Model Context Protocol)로 도구를 판다면, `registerTool`
튜플 하나를 감싸는 것으로 호출당 과금이 붙습니다:

```ts
import { paidTool } from "@x402.kit/seller/mcp";

server.registerTool(...paidTool("market_report",
  { accepts: [terms], facilitator },   // 같은 옵션; resource 기본값은 mcp://tool/<이름>
  { description: "A paid market report", inputSchema: { ticker: z.string() } },
  async ({ ticker }) => ({ content: [{ type: "text", text: report(ticker) }] }),
));
```

조건은 `isError` 도구 결과로 나가고, 결제는 `_meta["x402/payment"]`로 들어오며,
영수증은 `_meta["x402/payment-response"]`로 나갑니다 — 이 가이드의 나머지 전부
(조건, facilitator, 리플레이 가드, 결과 `_meta`의
`"x402kit/settlement-overrides"` 오버라이드를 통한 `upto`,
`settle: "after-handler"`)가 그대로 적용됩니다. 공식 `@x402/mcp` SDK와 양방향
와이어 호환. 실행 예시: `examples/paid-mcp-tool.ts`.

---

## 3. Facilitator 연결

`facilitator` 옵션은 두 가지를 받습니다.

**URL 문자열** — 가장 흔한 경우. 인증키·타임아웃을 주려면 `FacilitatorClient`를 직접
만드세요:

```ts
import { FacilitatorClient } from "@x402.kit/seller";

const facilitator = new FacilitatorClient("https://facilitator.example.com", {
  apiKey: process.env.FACILITATOR_API_KEY,  // 운영자가 준 SETTLE_API_KEY
  timeoutMs: 30_000,                        // 기본 30초
  // allowInsecure: true,                   // 루프백이 아닌 http:// 는 기본 경고
});
```

**`verify`/`settle`을 가진 객체** — facilitator를 판매자 프로세스 안에 내장할 때:

```ts
import { createFacilitator, loadConfig } from "@x402.kit/facilitator";

const facilitator = createFacilitator(loadConfig("facilitator.config.json"));
createPaywall({ accepts, facilitator });   // HTTP 왕복 없음
```

내장 방식은 판매자 서버가 가스용 개인키를 들고 있게 되므로, 별도 운영 팀이 있다면
분리 배포를 권장합니다. 내장 여부와 무관하게 설정 방법은
[`operator-guide.ko.md`](./operator-guide.ko.md)와 같습니다.

### 부팅 시 설정 검증

```ts
const gate = createPaywall(options);
await gate.verifySupported();   // accepts의 모든 (scheme, network)를 facilitator가 지원하는지 확인 — 불일치 시 throw
```

첫 고객이 오기 전에 "facilitator가 이 체인을 모른다"를 잡아줍니다. 내장
facilitator에는 no-op입니다.

---

## 4. 정산 모드 (`settle`)

언제 돈을 실제로 옮길지 결정합니다. 기본값이 가장 안전하고, 나머지는 명시적 선택입니다.

| 모드 | 동작 | 언제 쓰나 |
|---|---|---|
| `"sync"` (기본) | 검증 → **정산 완료** → 핸들러 실행 → 응답에 tx hash | 일반 유료 API. 가장 단순하고 돈이 확실히 들어온 뒤 상품을 내보냄. |
| `"after-handler"` | 검증 → 핸들러 실행 → 핸들러가 throw하지 않았을 때만 정산 | 핸들러가 실패할 수 있고, 실패 시 과금하고 싶지 않을 때. |
| `"async"` | 검증 → 즉시 응답 → 백그라운드 정산 → `onSettled`로 통보 | POS처럼 응답 지연이 중요한 경우. 승인/캡처 분리. |
| `"none"` | 검증만 → `onVerified`로 페이로드 인계 (필수) | 정산 시점을 직접 통제(구독 등록 등). |

```ts
paywall({
  accepts, facilitator,
  settle: "after-handler",
  onSettled: (result, payload) => {
    // after-handler / async 모드에서는 이 훅이 유일한 회계 채널입니다.
    if (!result.success) alertOps("settlement failed", payload, result.errorReason);
    else db.recordPayment(payload, result.transaction);
  },
});
```

주의점:
- `"after-handler"`의 "핸들러 실패 시 미과금" 보장은 **래퍼형 어댑터**(node, next,
  hono)에서만 성립합니다. 훅형인 express/fastify는 핸들러 전에 실행되므로 사실상
  `"sync"`처럼 동작합니다. node `withPaywall`은 이 모드에서 tx hash를 응답에 붙이지
  못합니다(헤더가 이미 전송됨) — `onSettled`에서 읽으세요.
- `"sync"` 외의 모든 모드에서는 상품이 먼저 나가고 체인이 nonce를 나중에 소비합니다.
  이때 "서명 하나 = 배송 하나"를 보장하는 것이 아래의 리플레이 가드입니다.

### 대면 결제: POS 프리셋

승인/캡처 분리를 카운터용으로 포장한 프리셋입니다 — HTTP 서버 없이, 402는 QR로
나가고 서명된 페이로드는 아무 채널로나 돌아옵니다:

```ts
import { createPosTerminal } from "@x402.kit/seller/pos";

const pos = createPosTerminal({ facilitator });
const order = pos.order(terms, { url: "pos://lane-1/order-42" });
show(order.qr);                                    // 402 조건, 와이어 인코딩
const auth = await order.authorize(wireFromPhone); // 승인 — 무료, 즉시
if (auth.authorized) {
  handOverTheGoods();
  await auth.capture();                            // 캡처 — 온체인, 나중에
}
```

`authorize`는 paywall 코어 전체를 돌리므로, 같은 서명을 두 번째 레인에 제시하면
facilitator 호출 없이 거부되고, facilitator 장애는 throw가 아니라
`{ authorized: false, reason }`으로 읽힙니다. `capture({ amount })`는 `upto`
조건에서 상한 이하 실액을 정산하고(팁 차감, 계량 과금), **무효화(void)는 그냥
capture를 안 하면 끝**입니다 — 체인에 아무것도 닿지 않았으니까요. 실행 예시:
`examples/pos-terminal.ts`.

---

## 5. 리플레이 가드와 다중 인스턴스

검증은 온체인 *읽기*라서, 정산이 채굴되기 전까지는 같은 서명을 N번 제시해도 모두
유효해 보입니다. 그래서 `paywall`은 facilitator를 부르기 **전에** 서명의
`paymentId`를 선점(claim)하고, 두 번째 제시는 402 `authorization_already_used`로
거부합니다. 기본 저장소는 프로세스 내 메모리입니다.

**판매자 인스턴스가 둘 이상이면** 공유 저장소를 넘겨야 합니다:

```ts
import type { ReplayStore } from "@x402.kit/seller";

const redisReplayStore: ReplayStore = {
  // 원자적 선점 — 처음 잡은 쪽만 true (SET NX PX)
  async claim(id, ttlMs) {
    return (await redis.set(`x402:replay:${id}`, "1", "PX", ttlMs, "NX")) === "OK";
  },
  // 검증이 결제를 거부하거나 정산이 확정 실패하면 paywall이 호출 — 구매자가 같은 서명으로 재시도할 수 있게 돌려줌.
  // `settlement_pending`에서는 호출되지 않음 — tx가 아직 들어갈 수 있으므로 TTL(max(maxTimeoutSeconds, 300)초)까지 선점 유지.
  async release(id) {
    await redis.del(`x402:replay:${id}`);
  },
};

paywall({ accepts, facilitator, replayStore: redisReplayStore });
```

`replayStore: false`로 끌 수 있지만, `settle: "sync"`이고 채굴 전 짧은 창구를
감수할 때만 의미가 있습니다.

함께 켜져 있는 방어:
- **리소스 바인딩** (`bindResource`, 기본 true): 페이로드에 `resource.url`이 있으면
  현재 라우트와 일치해야 합니다. `/cheap-a`용 서명을 `/cheap-b`에 들이미는 것을 막습니다
  (402 `invalid_payment_requirements`로 거부, facilitator 호출 없음).
- **헤더 크기 상한**: 8 KB(`MAX_PAYMENT_HEADER_BYTES`)를 넘는 `PAYMENT-SIGNATURE`는
  디코딩 전에 402 `invalid_payload`로 거부됩니다.
- **에러 메시지 제한**: 402에 실리는 사유는 알려진 프로토콜 코드만 그대로 전달되고
  나머지는 일반 메시지로 바뀝니다.

---

## 6. 장애 시 동작

| 상황 | 응답 | 비고 |
|---|---|---|
| 결제 헤더 없음 | 402 + `PAYMENT-REQUIRED` | 정상 플로우의 첫 단계 |
| 헤더 깨짐 | 402 `invalid_payload` | facilitator 호출 없음 |
| 모르는 조건으로 서명 | 402 `invalid_payment_requirements` | facilitator 호출 없음 |
| 같은 서명 재제시 | 402 `authorization_already_used` | facilitator 호출 없음 |
| 검증 실패 (잔액 부족, 만료 등) | 402 + 사유 + 새 조건 | 구매자가 다시 서명 가능 |
| facilitator 다운/타임아웃/이상 응답 | **503** `facilitator_unavailable` + `retry-after: 5` | HTTP facilitator 클라이언트의 모든 전송 실패가 throw 대신 이 503이 됨 — 500/스택트레이스 없음. (`onVerified`가 던진 예외도 claim을 되돌린 뒤 이 503이 됨. 직접 넘긴 `replayStore`나 내장 facilitator가 던지는 예외는 그대로 전파됨) |

503은 "결제 시스템 점검 중"으로 UI에 안내하면 됩니다. 구매자 측 `wrapFetch`는 503을
결제 거부로 취급하지 않고 그대로 돌려줍니다.

---

## 7. 구독·할부 (사전 서명 스케줄)

구매자가 청구 주기마다 한 건씩 결제를 **미리 서명**해 두면(`@x402.kit/buyer`의
`signPaymentSchedule`), 판매자는 받아서 저장하고 때가 되면 정산합니다. 402 왕복이
없으므로 청구 시점에 구매자가 오프라인이어도 됩니다.

```ts
import { validateSchedule, dueEntries, chargeScheduled, scheduleEntryId } from "@x402.kit/seller";

// 1) 구독 등록 엔드포인트 (Express, express.json() 사용) — body는 신뢰할 수 없는 JSON 배열
app.post("/subscribe", async (req, res) => {
  const result = validateSchedule(req.body, [monthlyTerms]);
  // 검사 항목: ≤1000개 · exact 스킴 · 조건 일치 · paymentId 고유 · 시간창 정렬·비중첩
  //           · 첫 창이 닫힌 지 1일 이내 · 허용 기간(기본 400일) 이내
  if (!result.ok) return res.status(400).json({ error: result.error });
  await db.saveSchedule(userId, result.value);
  res.json({ ok: true });
});

// 2) 청구 크론 — 예: 매시간
async function billingTick() {
  const now = Math.floor(Date.now() / 1000);
  // isSettled는 반드시 동기 함수 ((id, entry) => boolean) — 정산된 id를 먼저 로드
  const settled = new Set(await db.settledScheduleEntryIds());
  const isSettled = (id: string) => settled.has(id);
  for (const entry of dueEntries(await db.loadAllSchedules(), now, { isSettled })) {
    const result = await chargeScheduled(entry, facilitator);
    if (result.success) await db.recordCharge(scheduleEntryId(entry), result.transaction);
    else log.warn("charge failed", scheduleEntryId(entry), result.errorReason); // 다음 tick에 재시도
  }
}
```

책임 분담:
- **키트**: 검증, 시간창 계산, 제출. 너무 이른 제출은 스킴 자체의 시간 검사에서 거부됩니다.
- **판매자**: 저장, 재시도 정책, 해지 처리.

반드시 지킬 것:
- 저장된 항목 하나하나가 **살아 있는 무기명 결제 승인**입니다. 저장소를 암호화하고
  접근을 제한하세요.
- 정산 성공 시 `scheduleEntryId`를 함께 기록해서 크론이 같은 회차를 다시 제출하지
  않게 하세요 (`isSettled`가 이를 읽습니다).
- 전체 실행 예시는 `examples/subscription.ts`, `playground/c-schedule.ts`에 있습니다.

---

## 8. 체크리스트

- [ ] `extra` 도메인을 손으로 쓰지 않고 `erc3009Terms` / `permit2Terms`로 생성했다.
- [ ] facilitator URL이 `https://`이고, 운영자가 준 API 키를 `FacilitatorClient({ apiKey })`로 전달했다.
- [ ] 부팅 시 `verifySupported()`를 호출한다.
- [ ] 판매자 인스턴스가 여럿이면 공유 `replayStore`(Redis `SET NX PX`)를 넘겼다.
- [ ] `settle`이 `"sync"`가 아니라면 `onSettled`에서 실패를 기록·알림한다.
- [ ] 503 `facilitator_unavailable`을 UI/클라이언트가 점검 상태로 처리한다.
- [ ] 구독을 받는다면 스케줄 저장소를 암호화하고 `scheduleEntryId`로 중복 청구를 막았다.
- [ ] 수취 주소(`payTo`)를 facilitator 운영자의 `allowedPayTo`에 등록해 달라고 요청했다 (운영자가 그 방식을 쓰는 경우).

## 다음 단계

- `packages/seller/README.md` — 모든 옵션의 원문 레퍼런스 (영문).
- [`operator-guide.ko.md`](./operator-guide.ko.md) — facilitator를 직접 띄우는 법.
- [`dapp-guide.ko.md`](./dapp-guide.ko.md) — 구매자 측. 여러분의 API를 호출할 프론트엔드가 볼 문서.
- `examples/seller-paid-api.ts` — 이 가이드의 유료 API 흐름을 그대로 실행하는 예제.
