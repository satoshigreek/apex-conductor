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
- **BLOCKER-3** Registry datum schema may lack `endpoint`/`pricing` → resolved in M1 datum audit; `AgentProfileResolver` merges on-chain datum with signed off-chain manifests (`agent_manifests`).
- **BLOCKER-4** OFT path to Prime unconfirmed (ask Ethernal) → default assumption Base→Prime (Skyline) → Vector (Reactor); `OftAdapter` reserved.
- **MISSING-ARTIFACT** `apex-refuel.html` (SPEC §6.3) was not present on the build machine — `/refuel` web page built from spec description + §1.4 CFG values; drop the original at `apps/refuel/index.html` when located.

## Layout
`apps/web` (Next.js 14), `services/{conductor,indexer,refuel-api}` (Fastify), `packages/{core,chain-vector,chain-base,x402,llm}`, `contracts/escrow` (Aiken, M4), `infra/` (compose + migrations), `examples/agents/` (demo agents).
