# dapp에서 x402-kit 사용하기 (브라우저 지갑)

이 가이드는 프론트엔드 dapp을 "사용자가 지갑을 연결한 상태"에서 "사용자가 x402
엔드포인트에 결제를 완료한 상태"까지 안내합니다 — 패키지 README들이 이미 알고
있다고 가정하는 바로 그 경로입니다. 에이전트나 서버(직접 관리하는 개인키)를
만들고 있다면 buyer README의 `wrapFetch`가 더 간단합니다. 사람이 브라우저 지갑에서
결제를 하나씩 승인하는 경우에만 이 문서로 돌아오세요.

전체 통합은 세 단계입니다:

1. 브라우저 지갑을 `PaymentSigner`에 맞게 어댑터로 변환한다 (약 5줄).
2. 결제한다 — `wrapFetch`가 402 → 서명 → 재시도를 처리하게 하거나, 커스텀
   플로우가 필요하면 `signPayment`를 직접 호출한다.
3. (permit2 토큰만 해당) 구매자가 Permit2를 한 번 `approve`하게 한다.

---

## 1. 지갑 어댑터 — 직접 작성하는 유일한 접착 코드

구매자 측의 모든 것은 `PaymentSigner`를 받으며, 이 인터페이스는 의도적으로 아주
작습니다:

```ts
interface PaymentSigner {
  address: Address;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}
```

viem **wallet client**(wagmi의 `getWalletClient` / `useWalletClient`가 넘겨주는
것으로, MetaMask, Rabby, Coinbase Wallet, WalletConnect 세션 등 무엇이든 뒤에 둘 수
있음)는 이미 typed data 서명을 지원합니다 — 메서드가 페이로드와 함께 account를
받는다는 점만 다릅니다. 따라서 어댑터는 실제 코드라기보다 형태 변환에 불과합니다:

```ts
import type { Account, WalletClient } from "viem";
import type { PaymentSigner } from "@x402.kit/core";

export function walletSigner(wallet: WalletClient, account: Account | `0x${string}`): PaymentSigner {
  const address = typeof account === "string" ? account : account.address;
  return {
    address,
    signTypedData: (typedData) => wallet.signTypedData({ account, ...typedData }),
  };
}
```

이게 전부입니다. 구매자는 EIP-712 메시지(트랜잭션이 아니라 *허가*)에 서명합니다 —
가스도 없고, "트랜잭션 확인" 팝업도 없이 서명 요청만 뜹니다. 온체인 트랜잭션 제출과
가스 지불은 facilitator가 담당합니다.

> **패스키 / 스마트 계정 지갑**은 같은 `PaymentSigner` 인터페이스를 직접 구현합니다
> (P-256으로 서명하지만 `wrapFetch`는 이를 알 필요가 전혀 없습니다). 검증은 EOA,
> ERC-1271, ERC-6492 서명을 하나의 코드 경로로 처리하므로, 스마트 계정 구매자도
> 판매자 측에서 "그냥 동작"합니다.

---

## 2a. `wrapFetch`로 결제하기 (일반적인 경우)

dapp이 유료 엔드포인트를 `fetch`로 호출한다면, 한 번만 감싸면 결제가 보이지 않게
됩니다 — 402를 잡아서 서명하고 재시도합니다:

```ts
import { wrapFetch } from "@x402.kit/buyer";

const payFetch = wrapFetch(fetch, {
  signer: walletSigner(wallet, account),
  maxAmount: "5000000",          // atomic 단위의 상한 — 이 금액을 넘는 서명은 절대 하지 않음
  assets: [USDC],                // 필수 토큰 허용 목록 (maxAmount는 토큰을 구분하지 않음)
  onSkipped: (reason) => toast(`payment skipped: ${reason}`),
  onPaid: (terms, settlement) => toast(`paid, tx ${settlement?.transaction}`),
});

const res = await payFetch("/api/premium"); // 402 → 지갑 서명 프롬프트 → 재시도 → 200
```

`maxAmount`는 의도적으로 필수입니다 — 래퍼가 절대 넘어서 서명하지 않는 상한이므로,
탈취당했거나 오작동하는 엔드포인트가 지갑을 털어갈 수 없습니다. `assets`도
필수입니다: `maxAmount`는 단순한 atomic 단위 숫자이기 때문에, 토큰 허용 목록이
없으면 악의적인 402가 같은 숫자라도 실제 가치는 훨씬 비싼 토큰을 지정할 수 있습니다 (정말로 아무
토큰이나 받아도 된다면 `allowAnyAsset: true`를 설정하세요). 거부 시 예외를 던지지
**않습니다**: 원래의 402가 그대로 반환되고 `onSkipped`가 이유를 알려주므로 UI가
계속 주도권을 가집니다. (판매자가 `upto` 조건 — 판매자가 그 이하로 정산하는 상한 —
을 제시할 수도 있습니다. 이때 지갑 프롬프트에는 상한이 보이고, 실제 청구액은
`onPaid`의 `settlement.amount`로 알 수 있습니다.)

dapp에서 유일하게 신경 쓸 점: 서명 프롬프트는 비동기이며 사용자가 주도합니다.
`payFetch`가 이미 await하고 있으니, 호출을 자동 페이지 로드 fetch가 아니라 사용자
동작("결제" 버튼) 뒤에 두어서 지갑 팝업이 붙을 제스처가 있도록만 해주세요.

## 2b. `signPayment`로 결제하기 (커스텀 UI)

사용자에게 조건을 보여주고, 자체 확인 다이얼로그를 띄운 뒤 서명하고 싶다면 —
저수준 호출을 직접 제어하고 헤더도 직접 붙이세요:

```ts
import { signPayment } from "@x402.kit/buyer";
import {
  HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_SIGNATURE,
  decodePaymentRequiredSafe, encodePaymentPayload,
} from "@x402.kit/core";

// 1. 엔드포인트를 호출해 402 조건을 읽는다 (Safe 디코더는 헤더가 깨져도 예외를 던지지 않음)
const first = await fetch("/api/premium");
const required = decodePaymentRequiredSafe(first.headers.get(HEADER_PAYMENT_REQUIRED) ?? "");
if (!required.ok) throw new Error(`bad 402: ${required.error}`);
const terms = required.value.accepts[0]!;        // dapp이 지원하는 항목을 고른다 (유효한 402면 비어 있지 않음)

// 2. `terms`를 자체 UI에 표시하고, 확인 시:
const payload = await signPayment(terms, { signer: walletSigner(wallet, account) });

// 3. 서명 헤더를 붙여 요청을 다시 보낸다
const paid = await fetch("/api/premium", {
  headers: { [HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(payload) },
});
```

`signPayment`는 전송 방식에 구애받지 않습니다 — POS 단말기가 QR로 전달받은 조건에
서명할 때도 똑같은 호출을 사용합니다 (`playground/b-pos.ts` 참고).

---

## 3. Permit2 토큰: 1회성 approve

대부분의 ERC-20은 EIP-3009를 구현하지 않으므로, 키트는 이들을 Permit2로 라우팅합니다
(판매자의 조건에 `extra.assetTransferMethod: "permit2"`가 담겨 있음). Permit2는
토큰별로 구매자의 1회성 온체인 `approve`가 필요하며, 이것이 구매자 플로우에서
가스를 쓰는 유일한 동작입니다. 첫 결제 전에 해두세요:

```ts
import { approvePermit2 } from "@x402.kit/buyer";

// walletClient는 account가 설정된 viem WalletClient, publicClient는 체인 상태를 읽음
const tx = await approvePermit2({ walletClient, publicClient, token: TOKEN_ADDRESS });
// tx === undefined 이면 allowance가 이미 충분해서 아무것도 전송되지 않은 것
```

잘 만든 dapp은 이를 미리 확인해서 "{token} 활성화" 단계를 한 번만 보여주고 다시는
보여주지 않습니다. EIP-3009를 구현한 토큰(예: USDC)은 이 단계를 완전히 건너뜁니다 —
approve가 필요 없습니다.

---

## 종합하기 (wagmi 스케치)

```ts
import { useWalletClient, usePublicClient, useAccount } from "wagmi";
import { wrapFetch, approvePermit2 } from "@x402.kit/buyer";

function usePayFetch(maxAmount: string, assets: `0x${string}`[]) {
  const { address } = useAccount();
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient();

  async function enable(token: `0x${string}`) {
    if (!wallet || !publicClient) throw new Error("connect a wallet first"); // usePublicClient()는 undefined일 수 있음
    return approvePermit2({ walletClient: wallet, publicClient, token });
  }

  const payFetch = wallet && address
    ? wrapFetch(fetch, { signer: walletSigner(wallet, address), maxAmount, assets })
    : undefined;

  return { payFetch, enable };
}
```

`payFetch`는 지갑이 연결되기 전까지 undefined입니다 — "결제" 버튼을 이 값으로
게이트하세요. `enable(token)`은 permit2로 정산되는 토큰을 위한 1회성 Permit2
approve입니다.

---

## 체크리스트

- [ ] 약 5줄짜리 `walletSigner` 어댑터를 작성했다 (viem wallet client → `PaymentSigner`).
- [ ] `wrapFetch`에 실제 `maxAmount` 상한과 `assets` 허용 목록을 모두 설정했다 (무인 동작에는 `maxTotalAmount`도).
- [ ] 결제 호출을 사용자 제스처 뒤에 두어 지갑 프롬프트가 붙도록 했다.
- [ ] permit2로 정산되는 토큰에는 1회성 `approvePermit2` "활성화" 단계를 추가했다 (그리고 설정 어딘가에 `revokePermit2` "비활성화"도 — allowance는 무제한이며 앱보다 오래 남는다).
- [ ] `onSkipped` / 거부를 UI에 표시했다 (예외를 던지지 않으므로).

## 다음 단계

- `packages/buyer/README.md` — 모든 `wrapFetch` 옵션 (asset/network 필터, 동의,
  유효기간 클램핑, axios 어댑터).
- `playground/` — 실행 가능한 seller + buyer + facilitator. `a-online.ts`는 이
  가이드 2단계가 따르는 유료 API 플로우입니다.
- `packages/seller/README.md` — dapp이 *판매*도 한다면 반대편 이야기.
