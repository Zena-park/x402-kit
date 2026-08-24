# 개요 — 누가 무엇을 띄우나

> English original: [docs/overview.md](../../docs/overview.md)

이 페이지를 먼저 읽고, 맨 아래에서 자기 역할의 가이드를 고르세요.

## 1. 결제 한 건

`402 Payment Required`는 404처럼 HTTP 상태 코드의 하나로, **서버가 클라이언트에게
보내는 응답**입니다. 그래서 결제하는 쪽인 구매자는 클라이언트(에이전트 스크립트,
브라우저 탭, 크론 잡)이고, 서버로 떠 있어야 하는 쪽은 판매자의 API와 facilitator입니다.

```
구매자                                  판매자                       facilitator            체인
  │── GET /premium ─────────────────────▶│                                │                    │
  │◀── 402 + PAYMENT-REQUIRED ───────────│  "토큰 X 10000을 주소 Z로"     │                    │
  │   (조건에 서명 — tx 없음, 가스 없음) │                                │                    │
  │── GET /premium + PAYMENT-SIGNATURE ─▶│── POST /verify, /settle ──────▶│── 이체 tx ────────▶│
  │                                      │◀── tx hash ────────────────────│   (가스 지불)      │
  │◀── 200 + PAYMENT-RESPONSE ───────────│  핸들러 실행; 헤더 = tx hash   │                    │
```

- 토큰은 온체인 이체 한 번으로 **구매자 → 판매자의 `payTo`**로 이동합니다. facilitator를 거치지 않으며, facilitator는 가스만 냅니다.
- `wrapFetch`(구매자) = "402를 잡아 서명하고 다시 보내기". `paywall`(판매자) = "402를 보내고, 서명을 전달하고, 결제 후 서비스 제공". facilitator = "검증, 브로드캐스트, 가스 지불".

## 2. 세 역할

| | **구매자** | **판매자** | **Facilitator 운영자** |
|---|---|---|---|
| 띄우는 것 | 내 앱 / 에이전트 / 프론트엔드 | 내 HTTP API | Docker 컨테이너 하나 (`x402-kit/facilitator`) |
| 패키지 | `@x402.kit/buyer` | `@x402.kit/seller` | `@x402.kit/facilitator` |
| 보유 키 | 결제 지갑의 키 (또는 사용자의 브라우저 지갑) | **없음** | **가스** 지갑의 키 — 토큰은 절대 보유하지 않음 |
| RPC | 1회성 Permit2 approve 때만 | 아니오 | 예, 체인당 하나 |
| 트랜잭션 전송 | 아니오 — 서명만 | 아니오 | 예, 모든 정산 |
| 설정 한 줄 | `wrapFetch(fetch, { signer, maxAmount, maxTotalAmount, assets })` | `paywall({ accepts, facilitator })` | `facilitator.config.json` + `PRIVATE_KEY` + `SETTLE_API_KEY` |

세 패키지 모두 `@x402.kit/core`(타입, 와이어 코덱, 스킴, 서명 검증) 위에 있습니다.

## 3. 내 역할은 무엇인가?

| 나는… | 내가 띄우는 것 | 나머지 |
|---|---|---|
| **API를 판다** | 판매자 미들웨어 **+** facilitator (내 가스 지갑, 사설망, API 키를 가진 내 API만 호출) | 구매자는 모르는 사람들; 내 것을 아무것도 띄우지 않음 |
| **결제하는 에이전트를 만든다** | 구매자 쪽만 | 판매자의 402가 조건을 알려줌; 그쪽 facilitator는 그쪽 문제 |
| **여러 판매자를 받는 플랫폼** | 모두를 위한 facilitator 하나 — `allowedPayTo`에 판매자 전원, 판매자별 API 키 | 판매자는 미들웨어만 띄움 |
| **로컬 개발 중** | `npm run playground` — anvil + 세 역할 전부 한 머신에, 실제 결제, 외부로 아무것도 안 나감 | — |

소규모 배포는 두 번째 컨테이너 대신 facilitator를 API 프로세스에 내장할 수 있습니다
(`createFacilitator()` — 운영자 가이드 §7). 이 경우 API 서버가 가스 키를 들게 됩니다.

## 4. 구매자는 두 종류, 와이어는 하나

| | 에이전트 / 봇 / 서버 | 브라우저 dapp |
|---|---|---|
| 승인 주체 | 없음 — 프로세스가 상한 아래서 서명 | 사용자, 지갑 팝업에서 |
| 서명자 | `privateKeyToAccount(KEY)` | wallet client → 5줄 어댑터 |
| 필수 | `maxTotalAmount` (누적 예산) | 사용자 제스처 뒤의 호출 |

판매자와 facilitator는 둘을 구분하지 못합니다.

## 5. 토큰도 두 종류, 판매자의 조건이 결정

| 토큰 | 예 | 구매자의 1회성 준비 | 판매자가 조건 생성에 쓰는 것 |
|---|---|---|---|
| EIP-3009 | USDC | 없음 | `erc3009Terms()` |
| 일반 ERC-20 | 그 외 거의 전부 | 토큰당 `approvePermit2()` 1회 — 구매자가 쓰는 유일한 가스 | `permit2Terms()` |

어느 쪽이든 facilitator 설정의 허용 목록에 그 토큰이 있어야 합니다. 또 다른 축은
**가격 방식**입니다: `exact`(고정가, 서명한 그대로) 또는 `upto`(구매자가 상한에
서명하고 판매자가 실액을 정산 — Permit2 전용).

## 6. 내 가이드

| 역할 | 가이드 |
|---|---|
| 결제하는 에이전트 / 봇 / 서버 | [agent-guide.ko.md](./agent-guide.ko.md) |
| 결제하는 브라우저 dapp | [dapp-guide.ko.md](./dapp-guide.ko.md) |
| 과금하는 API | [seller-guide.ko.md](./seller-guide.ko.md) |
| Facilitator 운영자 | [operator-guide.ko.md](./operator-guide.ko.md) |

레퍼런스: `packages/*/README.md` (모든 옵션) · `examples/` (사용 사례별 실행 파일) · [`playground/`](../../playground/README.ko.md) (설명이 곁들여진 엔드투엔드 데모, 한국어 README).
