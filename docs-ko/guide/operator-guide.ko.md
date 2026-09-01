# 운영자 가이드 — facilitator 띄우고 안전하게 운영하기

이 가이드는 **facilitator 운영자** 입장의 문서입니다. facilitator는 x402 결제의
"정산 대행자"로, 판매자가 보내온 구매자 서명을 검증(`/verify`)하고 온체인
트랜잭션으로 제출(`/settle`)합니다. **트랜잭션 가스는 운영자의 지갑이 냅니다.**
그래서 이 문서의 절반은 "띄우는 법"이고, 나머지 절반은 "내 가스가 새지 않게 하는 법"입니다.

판매자 서버 쪽 설정은 [`seller-guide.ko.md`](./seller-guide.ko.md)를 보세요.

---

## 0. 준비물

| 항목 | 설명 |
|---|---|
| **서명 키** | 가스를 낼 EOA의 개인키. 이 지갑에 네이티브 토큰(ETH 등)을 채워 두세요. 다른 용도와 **섞어 쓰지 마세요** — 전용 지갑을 새로 만드세요. |
| **RPC URL** | 체인마다 하나. 공개 RPC는 rate limit이 있으니 운영 환경에선 유료/자체 노드를 권장합니다. |
| **토큰 목록** | 정산을 허용할 ERC-20 주소와 EIP-712 도메인(`name`, `version`). |
| Node 20+ 또는 Docker | 실행 환경 (Docker 이미지는 Node 22 탑재). |

---

## 1. 설정 파일

`facilitator.config.json` 하나로 끝납니다.

```jsonc
{
  "port": 4021,                                  // 기본 4021
  "chains": [
    {
      "network": "eip155:8453",                  // CAIP-2. eip155:* (EVM)만 지원
      "rpcUrl": "https://mainnet.base.org",
      "tokens": [
        {
          "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // USDC on Base
          "name": "USD Coin",                    // EIP-712 도메인 — 토큰 컨트랙트와 정확히 일치해야 함
          "version": "2",
          "minAmount": "10000"                   // 선택. 이 금액(atomic) 미만은 정산 거부. 기본 "1"
        }
      ]
      // "erc6492Settler": "0x...",              // 선택. 미배포 스마트월렛의 첫 결제 지원
      // "permit2Address": "0x...",              // 선택. 기본은 캐노니컬 CREATE2 주소
      // "permit2Proxy": "0x...",                // 선택. 기본은 캐노니컬 x402ExactPermit2Proxy
      // "uptoPermit2Proxy": "0x...",            // 선택. 기본은 캐노니컬 x402UptoPermit2Proxy
      // "maxSettleGas": 300000,                 // 선택. 정산 tx 가스 상한. 기본 300k
      // "maxErc6492SettleGas": 1500000          // 선택. 6492 배포+정산 경로 상한. 기본 1.5M
    }
  ],
  "allowedPayTo": ["0xYourSellerAddress"],       // 노출 제어 — 아래 §3 참고
  "rateLimitPerMinute": 300,                     // 선택. IP당 POST 요청/분. 0이면 해제. 기본 300
  // "trustProxy": true,                         // 선택. x-forwarded-for 첫 홉 기준으로 레이트리밋. 반드시 직접 운영하는 리버스 프록시 뒤에서만
  "maxInflightSettles": 16                       // 선택. 체인당 동시 정산 상한. 기본 16
  // "signerKeyEnv": "PRIVATE_KEY",              // 선택. 키를 읽을 env 변수명
  // "settleApiKeyEnv": "SETTLE_API_KEY"         // 선택. API 키를 읽을 env 변수명
}
```

설정 파일의 모든 주소·숫자는 **시작 시점에** 검증됩니다. 오타가 있으면 요청을 받기
전에 `configuration error`로 종료(exit code 2)합니다.

### `tokens`에 대해

- 기본은 **허용 목록**입니다. 목록에 없는 토큰은 `/verify`에서 거부됩니다.
- `"tokens": "*"`로 모든 토큰을 받을 수 있지만 **명시적 opt-in**입니다. 모르는 토큰의
  `transferWithAuthorization`이 무슨 짓을 하든 그 가스는 여러분이 냅니다.
- `name`/`version`은 검증용 신뢰 도메인으로도 쓰입니다. 틀리면 그 토큰의 모든
  결제가 검증 실패합니다. 판매자가 `erc3009Terms`로 읽어낸 값과 같아야 합니다.
- Permit2 경로(`permit2Terms`로 만든 조건)도 토큰 주소가 목록에 있어야 합니다.
  이 경우 `name`/`version`은 검증에 쓰이지 않지만 필드는 채워야 합니다.

---

## 2. 실행

### 2a. 개발 환경에서 바로 (모노레포 안)

```bash
PRIVATE_KEY=0x... FACILITATOR_CONFIG=./facilitator.config.json npm run facilitator
```

### 2b. 패키지로

```bash
PRIVATE_KEY=0x... FACILITATOR_CONFIG=./facilitator.config.json npx x402-facilitator
```

### 2c. Docker (권장)

```bash
# 모노레포 루트에서 빌드
docker build -f packages/facilitator/Dockerfile -t x402-kit/facilitator .

docker run -d --name facilitator \
  -v "$PWD/facilitator.config.json:/config.json:ro" \
  -e PRIVATE_KEY=0x... \
  -e SETTLE_API_KEY=... \
  -p 4021:4021 \
  x402-kit/facilitator
```

이미지는 `node` 유저(비root)로 실행되고 `FACILITATOR_CONFIG=/config.json`이 기본으로
설정되어 있습니다. 읽기 전용 마운트(`:ro`)로 충분합니다.

### 시작 시 일어나는 일

1. 설정 파일 파싱·검증.
2. `PRIVATE_KEY`(또는 `signerKeyEnv`) 읽기 → 형식 검사 → **`process.env`에서 삭제**.
   `SETTLE_API_KEY`도 마찬가지로 읽은 뒤 env에서 지웁니다.
3. 노출 제어 검사(§3). 통과 못하면 종료.
4. 서명 계정 도출. 이후 메모리상 config 객체의 키도 덮어씁니다.
5. 체인마다 `eth_chainId`를 호출해 `network`와 RPC가 같은 체인인지 확인. 불일치면 종료.
6. 리슨. 로그 첫 줄에 서명 주소·인증 방식·체인·토큰이 JSON으로 찍힙니다:

```json
{"t":"...","event":"started","port":4021,"signer":"0x...","settleAuth":"api-key","chains":[{"network":"eip155:8453","tokens":["0x8335..."]}]}
```

`settleAuth`가 `"NONE"`이면 `unauthenticatedSettle: true`를 켠 상태입니다.
운영 환경에서 이 값이 보이면 안 됩니다.

### 정상 동작 확인

```bash
curl -s localhost:4021/health
# {"ok":true,"gas":{"eip155:8453":"ok"}}   — 메모리에 10초 캐시되므로 상태 변화가 최대 10초 늦게 보임

curl -s localhost:4021/supported
# 판매자의 verifySupported()가 읽는 목록 — 설정한 (scheme, network) 조합이 전부 보여야 함.
# `upto` 항목에는 extra.facilitatorAddress(= 내 서명자)가 실림: 판매자가 uptoTerms에 넣고,
# 구매자가 서명에 바인딩하므로, 그 상한은 이 서명자만 인출할 수 있음.
```

---

## 3. 노출 제어 — 반드시 하나는 켜야 함

`/settle`은 운영자의 가스를 씁니다. 아무 보호 없이 인터넷에 열면, 허용 토큰을 가진
누구나 "1 wei를 나 자신에게" 결제를 만들어 여러분 가스로 무한 정산할 수 있습니다.
그래서 서버는 아래 셋 중 **하나도 없으면 시작을 거부**합니다.

| 방법 | 설정 위치 | 효과 | 권장 상황 |
|---|---|---|---|
| **API 키** | env `SETTLE_API_KEY` | `/verify`, `/settle`에 `authorization: Bearer <key>` 또는 `x-api-key: <key>` 필수. 상수 시간 비교. 없으면 401. | 판매자가 소수이고 키를 나눠줄 수 있을 때. **기본 권장.** |
| **수취 주소 허용 목록** | config `allowedPayTo` | 목록에 있는 주소로 가는 결제만 정산. 낯선 사람이 자기한테 보내는 결제는 거부. | 판매자 주소가 고정돼 있을 때. API 키와 **병행** 권장. |
| **명시적 무인증** | config `unauthenticatedSettle: true` | 보호 없이 실행. | 로컬/테스트, 또는 자체 게이트웨이(mTLS, VPN) 뒤. |

판매자 쪽에서는 이렇게 키를 전달합니다:

```ts
new FacilitatorClient("https://facilitator.example.com", { apiKey: process.env.FACILITATOR_API_KEY }) // 운영자가 준 SETTLE_API_KEY
```

**둘 다 켜는 것**이 가장 안전합니다 — 키가 새더라도 `allowedPayTo` 밖으로는 한 푼도
나가지 않습니다.

---

## 4. 기본으로 켜져 있는 방어선

별도 설정 없이도 동작하는 것들입니다. 숫자를 바꿀 일이 있으면 §1의 필드를 쓰세요.

| 방어 | 기본값 | 막는 것 |
|---|---|---|
| IP당 토큰 버킷 (`rateLimitPerMinute`) | 300/분 | POST 엔드포인트 플러딩. 초과 시 429 + `retry-after: 1`. |
| 체인당 동시 정산 상한 (`maxInflightSettles`) | 16 | 느린 RPC 뒤에 nonce가 쌓이는 것. 초과 시 503 `settle_overloaded` + `retry-after: 2`, 아무것도 브로드캐스트하지 않음. |
| 본문 검증 | — | content-type 불일치 → 415, 64 KB 초과 → 413, JSON 오류 → 400. |
| 정산 가스 상한 (`maxSettleGas`) | 300k | 가스를 태우는 악성 토큰/컨트랙트 서명자. **verify 시뮬레이션에도 적용**되어 settle 전에 걸러짐. |
| ERC-6492 가스 상한 (`maxErc6492SettleGas`) | 1.5M | 위와 같음, 배포+정산 경로. |
| 토큰별 최소 금액 (`minAmount`) | 1 | 먼지 결제로 가스 소모. |
| 요청 본문 상한 | 64 KB, `application/json`만 | 대용량 본문. |
| 요청/헤더 타임아웃 | 15초 / 10초 | slow-loris. |
| 시작 시 `eth_chainId` 검사 | 항상 | 잘못된 RPC에 연결된 채 운영. |
| 키 스크러빙 | 항상 | `/proc/<pid>/environ`, 자식 프로세스, 크래시 덤프로 키 유출. |
| `/health`의 잔액 비노출 | 항상 | `ok` / `empty` / `unreachable`만 보고. 잔액 숫자는 절대 안 나감. |

---

## 5. 정산 정확성 — 알아두면 장애 시 당황하지 않는 것들

facilitator는 **상태 없음(stateless)** 입니다. DB가 없고, 체인이 유일한 진실입니다.
그 위에서 아래 규칙으로 동작합니다.

- **nonce 관리**: viem `nonceManager`로 동시 정산이 연속 nonce를 받습니다. 충돌 없음.
- **재검증**: 모든 `/settle`은 제출 직전에 검증을 다시 수행합니다. 검증 후 잔액이
  빠진 결제는 브로드캐스트되지 않습니다.
- **영수증 신뢰**: 브로드캐스트한 **바로 그 hash**의 영수증만 믿습니다. 같은 nonce의
  대체 tx는 증거가 아닙니다.
- **브로드캐스트 후 RPC 오류** → `settlement_pending` + hash로 응답(HTTP 503,
  `retry-after: 10`). 절대 "실패"로 단정하지 않습니다. 판매자가 같은 페이로드로 재시도하면
  `eth_getTransactionReceipt`로 상태를 맞춥니다.
- **리버트했는데 이체는 됐다** (누가 프런트런해서 같은 서명을 먼저 제출) → 성공으로,
  **그 tx hash**와 함께 보고합니다.
- **멱등성**: 같은 페이로드를 다시 settle하면 같은 결과가 돌아옵니다. 단, 이 캐시는
  **프로세스 메모리**입니다 — 아래 배포 제약의 이유입니다.

### 배포 제약: 서명 키 하나 = 인스턴스 하나

같은 키로 레플리카 두 개를 띄우면, 둘 다 같은 결제를 브로드캐스트하고 하나는
리버트합니다(가스 낭비). 수평 확장이 필요하면:

- 키를 **여러 개** 만들어 인스턴스마다 다른 키를 주고,
- 판매자/로드밸런서가 한 결제를 항상 같은 인스턴스로 보내게 하거나(스티키),
- 체인별로 인스턴스를 나누세요.

---

## 6. 운영 체크리스트

### 배포 전
- [ ] 전용 서명 지갑을 새로 만들었고, 다른 자산이 들어 있지 않다.
- [ ] 지갑에 가스가 있다 (`/health`의 `gas`가 `ok`).
- [ ] `SETTLE_API_KEY`를 설정했고 판매자에게 안전한 채널로 전달했다.
- [ ] `allowedPayTo`에 우리 판매자 주소들을 넣었다.
- [ ] `tokens`가 `"*"`가 아니며, 각 토큰의 `name`/`version`이 온체인 도메인과 일치한다.
- [ ] 시작 로그의 `settleAuth`가 `"NONE"`이 아니다.
- [ ] TLS 종단(리버스 프록시)을 앞에 두었다 — facilitator 자체는 HTTP만 제공.
- [ ] 키·API 키를 시크릿 매니저에서 주입하며, 이미지·설정 파일·로그에 박혀 있지 않다.

### 운영 중
- [ ] `/health`를 모니터링에 연결했다 — `503`이면 가스 고갈(`empty`) 또는 RPC 장애(`unreachable`).
- [ ] 서명 지갑 잔액 알림을 걸었다 (`/health`는 잔액을 알려주지 않으므로 별도로).
- [ ] `settle_overloaded`(503)가 지속되면 RPC 품질 또는 `maxInflightSettles`를 점검한다.
- [ ] 429가 정상 판매자에게서 나오면 `rateLimitPerMinute`를 올리거나, 판매자들이 모두 직접 운영하는 리버스 프록시 하나를 거쳐 들어온다면 `trustProxy: true`를 켠다 (그러면 판매자마다 별도 버킷을 갖고, 미인증 호출자는 이미 별도 버킷을 쓴다).
- [ ] 로그(JSON 한 줄씩)를 수집한다. `event: "error"`에 알림.

### 키 교체
1. 새 키로 새 인스턴스를 띄운다 (새 지갑에 가스 충전).
2. 판매자 트래픽을 새 인스턴스로 돌린다.
3. 옛 인스턴스에 진행 중인 정산이 하나도 남지 않을 때까지 기다린 뒤 내린다.
4. 옛 지갑의 잔여 가스를 회수한다.

---

## 7. 판매자 프로세스에 내장하기

별도 서버 없이 판매자 프로세스 안에서 돌릴 수도 있습니다:

```ts
import { createFacilitator, loadConfig } from "@x402.kit/facilitator";
import { createPaywall } from "@x402.kit/seller";

const facilitator = createFacilitator(loadConfig("facilitator.config.json"));
const gate = createPaywall({ accepts, facilitator });   // HTTP 왕복 없음
```

내장 모드에서는:
- `unauthenticatedSettle`, `rateLimitPerMinute`, API 키 같은 **HTTP 계층 보호가 적용되지
  않습니다** — 외부에서 부를 수 없으니 필요도 없습니다.
- 대신 판매자 프로세스가 가스 키를 들게 됩니다. 판매자 서버의 보안 수준이 곧 키의
  보안 수준입니다.
- `loadConfig`는 동일하게 `process.env`에서 키(와 API 키)를 읽고 스크러빙합니다. 이어서
  `createFacilitator`가 넘겨받은 config 객체의 `signerKey`를 덮어쓰므로 그 객체를 재사용하지
  마세요. 키를 시크릿 매니저에서 가져온다면 `ResolvedConfig`를 직접 만들어도 됩니다
  (`examples/self-host-facilitator.ts` 참고).
- 내장 시 `assertSettleExposure`는 **자동으로 호출되지 않습니다** — 나중에 verify/settle을
  HTTP로 노출한다면 직접 호출하세요.

커스텀 스킴이 필요하면 두 번째 인자로 넘깁니다: `createFacilitator(config, [myScheme])`
(`@x402.kit/core`의 `SchemeHandler` 구현체).

---

## 8. 로컬에서 전체 흐름 돌려보기

실제 체인에 연결하기 전에 anvil 위에서 판매자·구매자·facilitator가 실제 결제를 주고받는
것을 확인할 수 있습니다. 외부 네트워크로 아무것도 나가지 않습니다.

```bash
# 요구사항: Node 20+, foundry (anvil/cast/forge)
npm install
npm run playground          # A(유료 API) → B(POS) → B2(금액 미확정) 전부
npm run e2e                 # 자동 테스트 하니스
./examples/run.sh           # 사용 사례별 독립 레시피
```

`playground/README.ko.md`에 각 장이 어떤 시나리오를 다루는지 정리되어 있습니다.

---

## 다음 단계

- `packages/facilitator/README.md` — 원문 레퍼런스 (영문).
- [`seller-guide.ko.md`](./seller-guide.ko.md) — 이 facilitator를 쓸 판매자가 볼 문서.
- `examples/self-host-facilitator.ts` — 내장형을 타입체크되는 레시피로.
