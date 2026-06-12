# Apex Conductor + Refuel

Two surfaces, one system (see [SPEC.md](SPEC.md)):

1. **Conductor** — an LLM master agent that takes a natural-language intent, discovers specialists
   from the on-chain Vector Agent Registry, plans a DAG, routes by reputation/price/stake, pays
   agents in AP3X after verification, and anchors an audit summary on-chain. Surfaces: web chat,
   REST/SSE, and a single MCP tool `conduct(intent, budgetAp3x)`.
2. **Refuel** — the payment abstraction: USDC on Base → bAP3X (Aerodrome Slipstream) → bridge
   toward Vector → AP3X gas credit. Plus x402 per-call micropayments (HTTP 402 + EIP-3009).

## Status (2026-06-12)

| Milestone | State |
|---|---|
| **M0** scaffold | ✅ `pnpm build && pnpm test` green (10 packages, 65+ tests) |
| **M1** registry truth | ✅ live datum audit ([docs/datum-audit.md](docs/datum-audit.md)) — 782 agents indexed from Vector **mainnet**; `GET /v1/agents` verified live; BLOCKER-3 confirmed → manifest fallback shipped |
| **M2** conductor MVP | ✅ code + local E2E (`node scripts/e2e-local.mjs`: live catalog → manifest → routed agent call → tier-0 verify → payment → anchor). ⏳ on-chain testnet E2E needs faucet funds (see CLAUDE.md gates) |
| **M3** refuel | ✅ code + live mainnet **quotes** through the corrected Slipstream route (~$0.0173/bAP3X); x402 **v2** settle path wire-confirmed against the live x402.org facilitator (BLOCKER-6 resolved). ⏳ live swap is a manual `$5 / REFUEL_LIVE=true` step |
| **M4** escrow (Aiken) | 🟡 validator written, `aiken check` 10/10 green, blueprint built ([contracts/escrow](contracts/escrow)). ⏳ testnet deploy + PaymentEngine v2 integration + **external audit before mainnet** |
| **M5** mainnet gate | ⛔ gated on M4 audit |

Read the **blockers ledger in [CLAUDE.md](CLAUDE.md)** before touching bridge, registry, or swap code —
two spec assumptions were corrected against the live chain (BLOCKER-5 swap route, BLOCKER-6 x402 version).

## Quickstart (no Docker required)

```bash
pnpm install && pnpm build && pnpm test

# conductor against Vector mainnet (read-only catalog), in-memory store:
cd services/conductor
VECTOR_NETWORK=mainnet KOIOS_URL=https://koios.vector.apexfusion.org/api/v1 \
DATABASE_URL=memory:// node dist/main.js
# → GET http://localhost:4000/v1/agents

# demo agents (:5001-5003) + full local E2E:
node examples/agents/demo-agents/dist/serve.js &
node scripts/e2e-local.mjs   # conductor must run with ALLOW_UNVERIFIED_MANIFESTS=true ROUTER_MIN_STAKE_AP3X=0

# refuel api (dry-run quotes against Base mainnet):
cd services/refuel-api && node dist/main.js
# → POST http://localhost:4200/v1/refuel {"usdcAmount":25,"vectorAddress":"vector_…"}

# web (Next.js — conductor chat, /refuel pipeline + gas tank, /agents, /tasks):
pnpm --filter @apex/web dev
```

With Docker: `docker compose -f infra/docker-compose.yml up -d` then `pnpm db:migrate`
and point `DATABASE_URL`/`REDIS_URL` at the containers (`QUEUE_DRIVER=bullmq`).

## Layout

`apps/web` · `services/{conductor,indexer,refuel-api}` · `packages/{core,chain-vector,chain-base,x402,llm}`
· `contracts/escrow` (M4) · `examples/agents` · `infra/` — stack and conventions in [CLAUDE.md](CLAUDE.md).
