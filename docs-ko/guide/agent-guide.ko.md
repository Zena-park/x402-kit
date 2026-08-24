# 에이전트 가이드 — 봇·에이전트·서버가 API에 결제하기

이 가이드는 **무인 구매자**를 위한 문서입니다. 유료 툴을 호출하는 AI 에이전트,
과금형 데이터 피드를 치는 크론 잡, 유료 API를 소비하는 백엔드 서비스가 여기
해당합니다. 핵심 특징은 **결제를 하나씩 승인해 줄 사람이 없다**는 것 — 프로세스가
키를 들고 스스로 서명합니다. 사람이 브라우저 지갑에서 매번 승인한다면
[`dapp-guide.ko.md`](./dapp-guide.ko.md)를 보세요. 와이어 프로토콜은 같고, 서명자와
안전 모델만 다릅니다.

통합은 세 단계입니다:

1. 키를 서명자로 만든다 (한 줄 — 어댑터 불필요).
2. `fetch`를 `wrapFetch`로 감싸되 **두 개의 상한**(건당·누적)을 건다.
3. (permit2 토큰만) 토큰별로 Permit2를 한 번 `approve`한다.

그 뒤는 전부 "감독 없이 안전하게 돌리는 법"입니다.

---

## 1. 서명자 — viem `LocalAccount`가 이미 서명자다

`PaymentSigner`는 `{ address, signTypedData }`입니다. viem의 `privateKeyToAccount`가
정확히 그걸 반환하므로:

```ts
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`);
```

이 키는 결제를 위해 **트랜잭션을 보내지 않습니다** — EIP-712 승인에 서명만 하고,
facilitator가 자기 가스로 이체를 제출합니다. 온체인 동작은 §3의 1회성 Permit2
approve뿐입니다. 여느 운영 시크릿처럼 다루세요: 시크릿 매니저에서 주입하고, 커밋하지
말고, 그 지갑에는 에이전트가 써도 되는 만큼만 넣으세요 (§4).

KMS/HSM 기반 서명자도 됩니다 — 서명 서비스 위에 `signTypedData`를 구현해
`{ address, signTypedData }`를 반환하면 됩니다.

---

## 2. 두 개의 상한을 건 `wrapFetch`

```ts
import { wrapFetch } from "@x402.kit/buyer";

const payFetch = wrapFetch(fetch, {
  signer,
  maxAmount: "100000",          // 건당 상한, atomic 단위 (0.10 USDC) — 필수
  maxTotalAmount: "20000000",   // 이 wrapper 수명 동안의 누적 상한 (20 USDC) — 무인이라면 반드시
  assets: [USDC],               // 토큰 허용 목록 — 필수 (maxAmount는 토큰을 구분 못 함)
  networks: ["eip155:8453"],    // 선택: 이 CAIP-2 네트워크만
  onPaid: (terms, settlement) => metrics.paid(terms.amount, settlement?.transaction),
  onSkipped: (reason, accepts) => log.warn("402 not paid:", reason),
});

const res = await payFetch("https://api.example.com/v1/answer", { method: "POST", body });
```

각 상한이 막는 것:

| 옵션 | 제한 대상 | 없으면 |
|---|---|---|
| `maxAmount` | 결제 한 건 | 악의적·오설정 402가 큰 금액을 부르면 에이전트가 그대로 서명 |
| `maxTotalAmount` | 이 wrapper가 서명하는 모든 결제의 합 | 판매자가 **매 요청마다** 402를 던지거나 에이전트 루프가 계속 호출하면, 합법적인 결제 한 건씩으로 지갑이 빈다 |
| `assets` | 어떤 토큰 | `maxAmount`는 소수점 개념 없는 정수라, 같은 숫자가 WBTC면 USDC의 수천 배 가치 |
| `maxValiditySeconds` (기본 300) | 서명 유효 시간 | 판매자가 `maxTimeoutSeconds`로 10년을 제안하면 서명이 장기 무기명 수단이 된다 |

`maxTotalAmount`의 예산은 **서명 전에 예약되고, 결제 요청이 판매자에 도달하지
못한 경우에만 환불**됩니다 — 즉 재시도가 전송 오류로 예외를 던진 경우입니다.
판매자에 도달했지만 non-2xx로 돌아온 재시도는 **예산에서 차감된 채로 남습니다**:
판매자가 유효한 서명을 받았으니 정산했을 수도 있기 때문입니다. 예산은 wrapper
인스턴스 안에 있으므로 — 예산 범위(에이전트 실행 단위, 테넌트, 태스크)마다
wrapper를 하나씩 만드세요.

### 거부는 예외를 던지지 않는다

정책상 결제할 수 없는 402를 만나면 `payFetch`는 **원래의 402 응답**을 돌려주고
`onSkipped(reason)`을 호출합니다. 결정은 여러분의 루프가 합니다 — 사람에게 에스컬레이션,
더 싼 툴 시도, 중단. 리소스를 실제로 받았는지 에이전트가 알아야 한다면 호출 뒤
`res.status === 402`를 확인하세요. (예외 둘: 결제 재시도가 리다이렉트되거나 origin을
넘어가면 wrapper는 서명 전달을 거부하고 그 3xx/cross-origin 응답을 대신 돌려줍니다.
이때도 `onSkipped`는 호출되므로, 상태 코드만 믿지 말고 훅을 보세요.)

### wrapper가 추가로 강제하는 것

- 결제·재시도는 **호출당 정확히 한 번**. wrapper 안에서 새 서명을 만들어 가며 지수 재시도하지 않습니다 — 여러분의 루프가 `payFetch`를 다시 부르는 것을 제한하는 게 `maxTotalAmount`입니다.
- 결제 재시도는 `redirect: "manual"`로 **같은 origin에만** 보냅니다 — 서명이 리다이렉트 대상으로 전달되지 않습니다. 다른 origin으로의 리다이렉트를 거쳐 도착한 402 역시 서명하지 않습니다.
- 스트리밍 요청 본문은 재전송이 불가능합니다. 결제하게 될 수 있는 본문은 버퍼링하세요.
- 402가 아닌 응답(판매자의 503 `facilitator_unavailable` 포함)은 그대로 통과합니다.

### 가격이 아니라 상한(`upto`)

사용량으로 과금하는 판매자(출력 토큰으로 청구하는 AI 호출 등)는 가격 대신 **상한**에
서명하라고 합니다(`upto` 스킴). wrapper는 이것도 기본으로 결제합니다: `maxAmount`가
상한(여러분이 승인하는 최악의 경우)을 제한하고, `maxTotalAmount` 예산에서도 **상한
전액**이 차감됩니다 — `PAYMENT-RESPONSE`로 전달되는 판매자 보고 실액(`onPaid`의
`settlement.amount`)은 판매자가 어떤 값이든 주장할 수 있으므로 회계 기록용일 뿐,
예산에는 반영되지 않습니다. 상한 하나는 한 번만 인출됩니다. 상한 자체를
거부하려면 `schemes: [exactScheme]`을 넘기세요.

### fetch 대신 axios

```ts
import { attachX402 } from "@x402.kit/buyer/axios";
attachX402(axiosInstance, { signer, maxAmount, maxTotalAmount, assets });
```

옵션도 게이트도 동일합니다.

---

## 3. Permit2 토큰: 유일한 트랜잭션

EIP-3009가 없는 토큰(대부분의 ERC-20)은 Permit2로 정산되며 구매자의 1회성 온체인
`approve`가 필요합니다. 에이전트 지갑이 가스를 쓰는 **유일한** 순간입니다:

```ts
import { approvePermit2 } from "@x402.kit/buyer";
import { createPublicClient, createWalletClient, http } from "viem";

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const walletClient = createWalletClient({ account: signer, transport: http(RPC_URL) });

// 배포 시 / 첫 실행 시, 토큰별로
await approvePermit2({ walletClient, publicClient, token: TOKEN });
// approve하면 tx hash, allowance가 이미 충분하면 undefined 반환 — 부팅 때마다 호출해도 안전.
// 해당 체인의 Permit2 주소에 컨트랙트 코드가 없으면(잘못된 체인 / 사설 배포) 예외를 던짐.
```

allowance는 관례상 무제한이고 에이전트보다 오래 남습니다.
`revokePermit2({ walletClient, publicClient, token })`이 0으로 되돌립니다 — 폐기할 때
호출하세요. USDC 등 EIP-3009 토큰은 이 단계를 건너뜁니다.

---

## 4. 무인 운영 — 운영 모델

위의 상한은 코드 수준 제한입니다. 그 위에 다음을 얹으세요.

**지갑 = 예산.** 에이전트 지갑에는 한 기간에 써도 되는 만큼만 넣으세요. 키가 털리거나
버그가 나도 잃는 건 그 잔액이 최대이고, `maxTotalAmount`는 그 이하여야 합니다. 충전은
여러분이 통제하는 금고에서 지갑 쪽으로만.

**예산 범위당 wrapper 하나.** `maxTotalAmount`는 wrapper 인스턴스별입니다. 여러
태스크를 처리하는 장수 프로세스라면 태스크/테넌트마다 wrapper를 만들어, 폭주한
태스크 하나가 다른 태스크의 예산을 먹지 못하게 하세요.

**두 훅과 상태 코드를 모두 관측.** `onPaid`는 지출 원장이고, `onSkipped`는 가격이
잘못된 엔드포인트·소진된 예산·악의적 402가 드러나는 곳입니다. 둘 다 메트릭으로
내보내세요 — "exceed maxTotalAmount" 사유의 `onSkipped`가 급증하면 에이전트가 천장에
닿아 모든 유료 호출을 조용히 실패시키고 있다는 뜻입니다. 알아둘 빈틈 하나:
`onPaid`는 **결제 재시도가 2xx로 돌아올 때만** 호출됩니다. non-2xx로 돌아온 결제
재시도는 어느 훅도 울리지 않지만 예산은 이미 차감된 상태이므로(판매자가 유효한
서명을 받았음), 원장이 정확해야 한다면 매 호출 뒤 반환된 `res.status`도 함께 기록하세요.

**402 정책은 wrapper가 아니라 루프에서 결정.** wrapper의 일은 상한을 넘겨 서명하지
않는 것뿐입니다. 거부됐을 때 뭘 할지 — 나중에 재시도, 다른 제공자, 사람에게 질문 —
는 에이전트 로직이고, `onSkipped`와 반환된 402가 그 판단에 필요한 정보를 줍니다.

**시계.** 서명에는 유효 시간창이 있습니다. 호스트 시계가 체인 시간과 어긋나면
facilitator가 거부합니다. NTP를 켜 두거나, 신뢰할 시간 소스를 `clock`으로 넘기세요.

---

## 5. LLM 툴 호출 안에서 (스케치)

```ts
// 에이전트 실행 단위마다 한 번, 그 실행의 예산으로 생성
const payFetch = wrapFetch(fetch, {
  signer, maxAmount: "100000", maxTotalAmount: runBudget, assets: [USDC],
  onPaid: (t) => ledger.push({ tool: "search", amount: t.amount }),
  onSkipped: (reason) => ledger.push({ tool: "search", skipped: reason }),
});

const tools = {
  search: async (query: string) => {
    const res = await payFetch(`https://search.example.com/q?q=${encodeURIComponent(query)}`);
    if (res.status === 402) return { error: "search is paid and the budget/policy refused it" };
    if (res.status === 503) return { error: "search payments temporarily unavailable" };
    return res.json();
  },
};
```

모델은 키도 상한도 보지 못합니다. 가끔 "거부됨"이라고 답하는 툴을 볼 뿐이고,
호출자는 원장에서 정확한 이유를 봅니다.

---

## 6. 에이전트의 구독

제공자가 호출당이 아니라 기간당 청구한다면, 에이전트는 한 번의 절차로 스케줄을
사전 서명할 수 있습니다:

```ts
import { signPaymentSchedule } from "@x402.kit/buyer";

const payloads = await signPaymentSchedule(monthlyTerms, {
  signer,
  periods: { start: Math.floor(Date.now() / 1000), periodSeconds: 30 * 86_400, count: 12 },
  maxTotalAmount: "120000000",  // 12 × 10 USDC — 이를 넘으면 서명 거부
  assets: [USDC],
});
await fetch("https://provider.example.com/subscribe", { method: "POST", body: JSON.stringify(payloads) });
```

노출은 정확히 `count × amount`이고, 각 회차는 자기 시간창 안에서만 정산됩니다.
`examples/subscription.ts` 참고.

---

## 체크리스트

- [ ] 키는 시크릿 매니저에서 주입, 지갑에는 해당 기간 예산만.
- [ ] `maxAmount` **와** `maxTotalAmount` **와** `assets` 설정, `maxTotalAmount` ≤ 지갑 잔액.
- [ ] 예산 범위(실행/테넌트/태스크)당 wrapper 하나.
- [ ] `onPaid`·`onSkipped`를 메트릭/로그에 연결, skip 급증 알림.
- [ ] 에이전트 루프가 반환된 402(정책 거부)와 503(facilitator 다운)을 명시적으로 처리.
- [ ] permit2 토큰: 부팅 시 `approvePermit2`, 폐기 시 `revokePermit2`.
- [ ] 호스트 시계 동기화 (또는 `clock` 제공).

## 다음 단계

- `packages/buyer/README.md` — 모든 `wrapFetch` 옵션.
- `examples/seller-paid-api.ts` — 에이전트가 유료 API에 결제하는 전체 흐름, anvil에서 실행 가능.
- [`seller-guide.ko.md`](./seller-guide.ko.md) — 호출하는 API가 반대편에서 하는 일.
- [`dapp-guide.ko.md`](./dapp-guide.ko.md) — 사람이 승인하는 변형.
