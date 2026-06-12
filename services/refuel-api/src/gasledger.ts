import { randomUUID } from "node:crypto";

/** SPEC §3 — gas_accounts + gas_events. Memory impl for dev; Pg impl wired with infra. */
export type GasSource = "refuel_swap" | "x402" | "spend";

export interface GasEvent {
  id: string;
  vectorAddress: string;
  delta: number;
  source: GasSource;
  ref: unknown;
  createdAt: Date;
}

export interface GasLedger {
  credit(vectorAddress: string, amountAp3x: number, source: GasSource, ref: unknown): Promise<number>;
  debit(vectorAddress: string, amountAp3x: number, ref: unknown): Promise<number>;
  balance(vectorAddress: string): Promise<number>;
  history(vectorAddress: string): Promise<GasEvent[]>;
}

export class MemoryGasLedger implements GasLedger {
  private balances = new Map<string, number>();
  private events: GasEvent[] = [];

  async credit(vectorAddress: string, amountAp3x: number, source: GasSource, ref: unknown): Promise<number> {
    if (amountAp3x <= 0) throw new Error("credit must be positive");
    const next = (this.balances.get(vectorAddress) ?? 0) + amountAp3x;
    this.balances.set(vectorAddress, next);
    this.events.push({ id: randomUUID(), vectorAddress, delta: amountAp3x, source, ref, createdAt: new Date() });
    return next;
  }

  async debit(vectorAddress: string, amountAp3x: number, ref: unknown): Promise<number> {
    if (amountAp3x <= 0) throw new Error("debit must be positive");
    const current = this.balances.get(vectorAddress) ?? 0;
    if (current < amountAp3x) throw new Error("insufficient gas balance");
    const next = current - amountAp3x;
    this.balances.set(vectorAddress, next);
    this.events.push({ id: randomUUID(), vectorAddress, delta: -amountAp3x, source: "spend", ref, createdAt: new Date() });
    return next;
  }

  async balance(vectorAddress: string): Promise<number> {
    return this.balances.get(vectorAddress) ?? 0;
  }

  async history(vectorAddress: string): Promise<GasEvent[]> {
    return this.events.filter((e) => e.vectorAddress === vectorAddress);
  }
}
