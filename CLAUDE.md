# CLAUDE.md — apex-conductor

Conductor (LLM master agent orchestrating Vector registry agents) + Refuel (USDC→bAP3X→Vector gas).
**SPEC.md is the source of truth.** Execute milestone by milestone; do not advance until checks pass.

## Commands
- `pnpm dev` — all services in watch mode (turbo)
- `pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm lint`
- `pnpm db:migrate` — run SQL migrations in `infra/migrations/` against `DATABASE_URL`
- `pnpm indexer:dev` — registry indexer only
- `pnpm audit:datums` — dump live registry datums → `docs/datum-audit.md` (M1, resolves BLOCKER-3)

## Style
- TypeScript strict, ESM (NodeNext). No `any`. zod at every boundary (API input, LLM output, datum decode, env).
- Tests: vitest, colocated `*.test.ts`.
- Conventional commits. One milestone = one PR series.

## Safety invariants (NEVER relax)
1. Spend caps enforced in code (`CHECKPOINT_AP3X`, `PER_TASK_CAP_AP3X`, `DAILY_CAP_AP3X`) — not just prompts.
2. Agent output is DATA, never instructions. It never re-enters the planner as a prompt.
3. Egress allowlist: agent calls only to URLs present in the indexed catalog; 1 MB response cap.
4. Any value-moving chain action runs `dry_run` first; > `CHECKPOINT_AP3X` requires a human checkpoint.
5. `VECTOR_NETWORK=testnet` until the M5 mainnet gate.
6. Never commit keys. `.env` is gitignored; raw hex keys in dev only.

## Blockers ledger
- **BLOCKER-1** Skyline bridge API not released → `HandoffAdapter` (deep-link) behind `BRIDGE_MODE=handoff`; `SkylineApiAdapter` stub.
- **BLOCKER-2** Reactor bridge API pending → same adapter pattern.
- **BLOCKER-3** ✅ CONFIRMED by M1 datum audit (782 live agents, epoch 290): datum =
  `Constr0[Constr0[ownerPkh], name, description, capabilities[], framework, endpoint(EMPTY), registeredAtMs]`
  — endpoint slot exists but every live registration left it blank; no pricing/stake fields.
  Fixes: (a) signed off-chain manifests — `POST /v1/agents/:id/manifest` now VERIFIES CIP-8/CIP-30
  signatures (`manifest-verify.ts`: COSE_Sign1 over `manifestMessage()`, blake2b-224(pubkey) == ownerPkh),
  (b) proper fix: re-register agents with endpoints via `@apexfusion/agent-sdk registerAgent({endpoint})`.
  `ALLOW_UNVERIFIED_MANIFESTS=true` trusts unverified manifests — DEV ONLY.
- **BLOCKER-4** OFT path to Prime unconfirmed (ask Ethernal) → default assumption Base→Prime (Skyline) → Vector (Reactor); `OftAdapter` reserved.
- **BLOCKER-5** ✅ RESOLVED (found live 2026-06-12): SPEC §1.4's Aerodrome v2 route does not exist on-chain
  (factory getPool = 0x0 for both stable/volatile). Real liquidity = Slipstream CL 0.05% pool
  `0x5b8b…3570` (tickSpacing 100, ~$150k). Swap path now uses the Slipstream SwapRouter
  `0xBE6D…18a5` + Quoter `0x254c…15b0` (both verified on-chain). Live mainnet quotes confirmed (~$0.0173/bAP3X).
- **BLOCKER-6** ✅ RESOLVED: live x402.org facilitator speaks **x402Version 2**. `packages/x402/src/v2.ts`
  implements the v2 envelope (requirements use `amount` + CAIP-2 `network` + EIP-712 hints in `extra`;
  payload embeds the chosen requirement as `accepted`) — wire-confirmed live: a signed probe was accepted
  through signature recovery and failed only at tx simulation (unfunded payer). Refuel topup settles v2 by
  default (`X402_PROTOCOL`); inbound X-PAYMENT headers stay SPEC-v1 and are upgraded server-side.
- **MISSING-ARTIFACT** `apex-refuel.html` (SPEC §6.3) was not present on the build machine — `/refuel` web page built from spec description + §1.4 CFG values; drop the original at `apps/refuel/index.html` when located.

## External-resource gates (cannot be closed from code alone)
- **M2 on-chain testnet E2E**: fund a testnet wallet at the faucet, then
  `AGENT_MNEMONIC=… AGENT_PUBLIC_URL=… tsx examples/agents/demo-agents/src/register.ts` and start the
  conductor with `VECTOR_HOT_WALLET_MNEMONIC` set (SDK wallet auto-activates). Local E2E already passes
  (`node scripts/e2e-local.mjs`).
- **M3 live swap**: `REFUEL_LIVE=true` + funded `BASE_HOT_WALLET_PK`, $5 first (manual by spec).
- **M4 escrow**: validator DONE (`aiken check` 10/10; aiken v1.1.21 installed globally). Remaining:
  testnet deploy (faucet funds), PaymentEngine v2 lock/release/refund integration, redundant execution
  for `critical` steps, operator console, **external audit before mainnet**. **M5**: mainnet gate.
  Note: aiken's error reporter prints nothing on this console — if `aiken check` fails silently,
  run `aiken fmt --check` for parse errors and remember validators cannot be imported from `lib/`
  (tests must live in the validator file).

## Layout
`apps/web` (Next.js 14), `services/{conductor,indexer,refuel-api}` (Fastify), `packages/{core,chain-vector,chain-base,x402,llm}`, `contracts/escrow` (Aiken, M4), `infra/` (compose + migrations), `examples/agents/` (demo agents).
