# contracts/escrow — Aiken per-task escrow validator (M4)

SPEC §5.2 Payments v2: lock at task start with inline datum `{taskId, conductorPkh, deadline, refundPkh}`,
per-step releases, refund path, 2-of-2 dispute path.

**Status: validator written and `aiken check` GREEN (10/10 unit tests).**
Toolchain: aiken v1.1.21, stdlib v2.2.0, Plutus V3. Blueprint: `plutus.json`
(script hash `095e723251ca846bb663acc6f0886ecb0f25c4ceb607d39f0a7a7b13` at v0.1.0).

Spend paths:
- **Release** — conductor signature AND tx ends strictly before `deadline` (finite upper bound
  required — unbounded validity is rejected) AND any output paying back to the script carries the
  unchanged inline datum (a partial release cannot rewrite escrow terms).
- **Refund** — refund signature AND tx starts strictly after `deadline`.
- **Dispute** — conductor AND refund co-sign (2-of-2), any time.

Tests live in `validators/escrow.ak` (aiken validators cannot be imported from `lib/`).
Run: `aiken check` · build blueprint: `aiken build`.

## Remaining for M4 acceptance
1. Testnet deploy + lock/release/refund observable on the explorer (needs faucet funds).
2. Conductor `PaymentEngine` v2: lock on task start, per-step release txs, refund on failure.
3. **External audit before mainnet** — declared scope: full per-step value accounting on Release,
   dispute timelock window, double-satisfaction across concurrent task escrows.
