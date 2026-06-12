/** SPEC §5.2 / CLAUDE.md safety invariant 1 — hard spend caps enforced in code. */
export interface SpendPolicy {
  checkpointAp3x: number;
  perTaskCapAp3x: number;
  perSessionCapAp3x: number;
  dailyCapAp3x: number;
  protocolFeeBps: number;
}

export const DEFAULT_POLICY: SpendPolicy = {
  checkpointAp3x: 50,
  perTaskCapAp3x: 200,
  perSessionCapAp3x: 500,
  dailyCapAp3x: 2000,
  protocolFeeBps: 250,
};

export type SpendDenial =
  | { ok: true }
  | { ok: false; reason: "per_task_cap" | "per_session_cap" | "daily_cap"; cap: number; attempted: number };

export function checkSpend(
  policy: SpendPolicy,
  spent: { task: number; session: number; day: number },
  amountAp3x: number,
): SpendDenial {
  if (spent.task + amountAp3x > policy.perTaskCapAp3x) {
    return { ok: false, reason: "per_task_cap", cap: policy.perTaskCapAp3x, attempted: spent.task + amountAp3x };
  }
  if (spent.session + amountAp3x > policy.perSessionCapAp3x) {
    return { ok: false, reason: "per_session_cap", cap: policy.perSessionCapAp3x, attempted: spent.session + amountAp3x };
  }
  if (spent.day + amountAp3x > policy.dailyCapAp3x) {
    return { ok: false, reason: "daily_cap", cap: policy.dailyCapAp3x, attempted: spent.day + amountAp3x };
  }
  return { ok: true };
}

export function requiresCheckpoint(policy: SpendPolicy, amountAp3x: number, mode: "auto" | "confirm"): boolean {
  return mode === "confirm" || amountAp3x > policy.checkpointAp3x;
}

export function protocolFee(policy: SpendPolicy, amountAp3x: number): number {
  return (amountAp3x * policy.protocolFeeBps) / 10_000;
}
