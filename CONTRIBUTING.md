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

## Checks

`npm run check` is the CI gate for the TypeScript packages (build, typecheck,
unit tests, production `npm audit`). The e2e token under `e2e/contracts` has
its own: `npm run contracts:check` (forge fmt, lint, tests), plus
`npm run slither` and `npm run halmos` (symbolic properties in
`test/symbolic/`), each a separate CI job. `npm run e2e` boots anvil and runs
every scenario. Foundry (`forge`, `anvil`, `cast`), `slither` and `halmos` are
needed locally for those; clone with `--recurse-submodules` (forge-std).
Run everything that touches what you changed before opening a PR.

## Updating dependencies

Dependabot opens weekly PRs for minor/patch bumps and for GitHub Actions; it
is configured to skip major bumps because `zod`, `typescript` and `vitest`
majors have each broken the build. Take majors by hand, on their own PR, with
the reason in the commit message. `viem` and `@x402/core` define the wire
format and the on-chain ABIs — read their changelogs before bumping.

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
