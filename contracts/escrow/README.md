# contracts/escrow — Aiken per-task escrow validator (M4)

SPEC §5.2 Payments v2: lock at task start with datum `{taskId, conductorPkh, deadline, refundPkh}`,
per-step releases, refund path, and a 2-of-2 timelocked dispute path.

**Status: NOT STARTED — gated on M4.** v1 (M2) runs escrowless hot-wallet payments
(`services/conductor/src/payments.ts`). Requirements before any mainnet deploy:

1. `aiken check` test suite covering lock / release / refund / dispute.
2. Testnet deployment with all three paths observable on the explorer.
3. **External audit booked before mainnet** (SPEC M4 acceptance).

Datum schema source of truth: `Apex-Fusion/vector-ai-agents` (`DEPLOY.md`).
