# Contributing

Thanks for helping with x402-kit.

## Setup

```sh
npm install
npm run build
npm test          # unit tests (vitest)
npm run typecheck
npm run e2e       # needs foundry (anvil) on PATH
```

Node 20+ is required.

## Pull requests

- Keep changes focused; one concern per PR.
- Add or update tests for behavior changes. Payment-path changes
  (verification, settlement, spending caps) need a test that exercises the
  failure case, not just the happy path.
- Run `npm test` and `npm run typecheck` before pushing.
- Do not commit private keys, RPC URLs with embedded credentials, or
  `facilitator.config.json` files. The only keys allowed in the repo are the
  public Anvil/Hardhat dev accounts used under `e2e/`, `examples/` and
  `playground/`.

## Security issues

See [SECURITY.md](SECURITY.md) — please do not file security bugs as public
issues.

## License

By contributing you agree that your contributions are licensed under the
Apache-2.0 license that covers the project.
