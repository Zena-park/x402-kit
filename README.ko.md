# x402-kit

x402 결제를 붙이려는 개발자를 위한 킷 — 자체 호스팅 facilitator · 판매자 미들웨어 ·
구매자 fetch 래퍼. 임의의 EIP-3009 토큰에서 동작한다.

[token-kit](https://github.com/Zena-park/token-kit) 으로 토큰을 찍고,
x402-kit 으로 그 토큰의 결제를 받는다.

```
packages/
├── core/          스펙 v2 타입 · 코덱 · 스킴 · 검증 파이프라인   @x402kit/core
├── facilitator/   /verify · /settle · /supported 자체 호스팅    @x402kit/facilitator
├── seller/        402 발행 미들웨어 (hono · express · next)     @x402kit/seller
└── buyer/         402 → 서명 → 재시도 fetch 래퍼               @x402kit/buyer
e2e/               anvil 에서 결제 한 건을 끝까지 + 적합성 교차 테스트
```

설계 문서는 `docs-ko/` (로컬 전용, 미추적). 구현 전 단계.
